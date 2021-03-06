import Layer from '../../Layer'
import Tensor from '../../Tensor'
import { webgl2 } from '../../WebGL2'
import ops from 'ndarray-ops'
import * as layers from '../'

/**
 * TimeDistributed wrapper layer class
 */
export default class TimeDistributed extends Layer {
  /**
   * Creates a TimeDistributed wrapper layer
   *
   * @param {Object} [attrs] - layer config attributes
   */
  constructor(attrs = {}) {
    super(attrs)
    this.layerClass = 'TimeDistributed'

    const { layer } = attrs

    if (!layer) {
      this.throwError('wrapped layer is undefined.')
    }

    const wrappedLayerAttrs = Object.assign({}, layer.config, { gpu: attrs.gpu })
    this.wrappedLayer = new layers[layer.class_name](wrappedLayerAttrs)

    // prevent GPU -> CPU data transfer by specifying non-empty outbound nodes array on internal layer
    this.wrappedLayer.outbound = [null]

    // GPU setup
    if (this.gpu) {
      this.copyTextureProgram = webgl2.compileProgram(require('../../copyTexture.glsl'))
      this.mapInputProgram = webgl2.compileProgram(require('../../mapInput.glsl'))
      this.selectSliceProgram = webgl2.compileProgram(require('./TimeDistributed.selectSlice.glsl'))
      this.copySliceOutputProgram = webgl2.compileProgram(require('./TimeDistributed.copySliceOutput.glsl'))
      this.mapSliceOutputProgram = webgl2.compileProgram(require('./TimeDistributed.mapSliceOutput.glsl'))
    }
  }

  /**
   * Method for setting layer weights
   * Passes weights to the wrapped layer
   *
   * @param {Tensor[]} weightsArr - array of weights which are instances of Tensor
   */
  setWeights(weightsArr) {
    this.wrappedLayer.setWeights(weightsArr)
  }

  /**
   * Layer computational logic
   *
   * @param {Tensor} x
   * @returns {Tensor}
   */
  call(x) {
    if (this.gpu) {
      this._callGPU(x)
    } else {
      this._callCPU(x)
    }
    return this.output
  }

  /**
   * CPU call
   *
   * @param {Tensor} x
   */
  _callCPU(x) {
    const stepShape = [...x.tensor.shape.slice(1)]
    const step = new Tensor([], stepShape)
    ops.assign(step.tensor, x.tensor.pick(0, ...Array(stepShape.length).fill(null)))
    let stepOutput = this.wrappedLayer.call(step)
    const stepOutputShape = stepOutput.tensor.shape.slice()
    this.output = new Tensor([], [x.tensor.shape[0], ...stepOutputShape])
    ops.assign(this.output.tensor.pick(0, ...Array(stepOutputShape.length).fill(null)), stepOutput.tensor)
    for (let i = 1, timesteps = x.tensor.shape[0]; i < timesteps; i++) {
      ops.assign(step.tensor, x.tensor.pick(i, ...Array(stepShape.length).fill(null)))
      stepOutput = this.wrappedLayer.call(step)
      ops.assign(this.output.tensor.pick(i, ...Array(stepOutputShape.length).fill(null)), stepOutput.tensor)
    }
  }

  /**
   * Creates row/col index mappings to map input texture to time-distributed slices
   *
   * @param {Object} indicesForReshaped
   */
  _createIndexMap(indicesForReshaped) {
    if (this.rowIndexMaps && this.colIndexMaps) {
      return
    }

    const indicesRow = new Tensor(indicesForReshaped.row.data, indicesForReshaped.row.shape, { type: Int32Array })
    const indicesCol = new Tensor(indicesForReshaped.col.data, indicesForReshaped.col.shape, { type: Int32Array })

    this.rowIndexMaps = []
    this.colIndexMaps = []

    const timesteps = this.inputShape[0]
    const sliceShape = this.inputShape.slice(1)
    for (let t = 0; t < timesteps; t++) {
      const sliceIndicesRow = new Tensor([], sliceShape, { type: Int32Array })
      const sliceIndicesCol = new Tensor([], sliceShape, { type: Int32Array })
      ops.assign(sliceIndicesRow.tensor, indicesRow.tensor.pick(t, ...Array(sliceShape.length).fill(null)))
      ops.assign(sliceIndicesCol.tensor, indicesCol.tensor.pick(t, ...Array(sliceShape.length).fill(null)))
      sliceIndicesRow.reshapeTo2DSquare()
      sliceIndicesCol.reshapeTo2DSquare()
      sliceIndicesRow.createGLTexture('2d', 'int')
      sliceIndicesCol.createGLTexture('2d', 'int')
      this.rowIndexMaps.push(sliceIndicesRow)
      this.colIndexMaps.push(sliceIndicesCol)
    }
  }

  /**
   * Creates row/col index mappings to map time-distributed slices to output texture
   *
   * @param {Object} indicesForReshaped
   */
  _createOutputIndexMap(indicesForReshaped) {
    if (this.outputRowIndexMaps && this.outputColIndexMaps) {
      return
    }

    const outputSliceIndicesRow = new Tensor(indicesForReshaped.row.data, indicesForReshaped.row.shape, {
      type: Int32Array
    })
    const outputSliceIndicesCol = new Tensor(indicesForReshaped.col.data, indicesForReshaped.col.shape, {
      type: Int32Array
    })

    this.outputRowIndexMaps = []
    this.outputColIndexMaps = []

    const timesteps = this.outputShape[0]
    const sliceShape = this.outputShape.slice(1)
    for (let t = 0; t < timesteps; t++) {
      const outputIndicesRow = new Tensor([], this.outputShape, { type: Int32Array })
      const outputIndicesCol = new Tensor([], this.outputShape, { type: Int32Array })
      ops.assigns(outputIndicesRow.tensor, -1)
      ops.assigns(outputIndicesCol.tensor, -1)
      ops.assign(outputIndicesRow.tensor.pick(t, ...Array(sliceShape.length).fill(null)), outputSliceIndicesRow.tensor)
      ops.assign(outputIndicesCol.tensor.pick(t, ...Array(sliceShape.length).fill(null)), outputSliceIndicesCol.tensor)
      outputIndicesRow.reshapeTo2DSquare()
      outputIndicesCol.reshapeTo2DSquare()
      outputIndicesRow.createGLTexture('2d', 'int')
      outputIndicesCol.createGLTexture('2d', 'int')
      this.outputRowIndexMaps.push(outputIndicesRow)
      this.outputColIndexMaps.push(outputIndicesCol)
    }
  }

  /**
   * GPU call
   *
   * @param {Tensor} x
   */
  _callGPU(x) {
    if (x.is2DReshaped) {
      this.inputShape = x.originalShape
    } else {
      this.inputShape = x.tensor.shape
    }

    if (!x.glTexture) {
      if (x.tensor.shape.length <= 2) {
        x.createGLTexture()
      } else if (x.tensor.shape.length > 2 && !x.is2DReshaped) {
        x.reshapeTo2DSquare()
        x.createGLTexture()
      }
    }

    if (this.inputShape.length > 2) {
      this._createIndexMap(x.indicesForReshaped)
    }

    const timesteps = this.inputShape[0]
    const sliceShape = this.inputShape.slice(1)

    if (!this.slice) {
      this.slice = new Tensor([], sliceShape)
      if (sliceShape.length <= 2) {
        this.slice.createGLTexture()
      } else {
        this.slice.reshapeTo2DSquare()
        this.slice.createGLTexture()
      }
    }

    if (this.inputShape.length <= 2) {
      webgl2.runProgram({
        program: this.selectSliceProgram,
        output: this.slice,
        inputs: [{ texture: x.glTexture, type: '2d', name: 'x' }],
        uniforms: [{ value: 0, type: 'int', name: 't' }]
      })
    } else {
      webgl2.runProgram({
        program: this.mapInputProgram,
        output: this.slice,
        inputs: [
          { texture: x.glTexture, type: '2d', name: 'x' },
          { texture: this.rowIndexMaps[0].glTexture, type: '2d', name: 'rowIndexMap' },
          { texture: this.colIndexMaps[0].glTexture, type: '2d', name: 'colIndexMap' }
        ]
      })
    }

    this.wrappedLayer._callGPU(this.slice)
    this.sliceOutput = this.wrappedLayer.output

    if (!this.output) {
      if (this.inputShape.length <= 2) {
        this.outputShape = [timesteps, this.sliceOutput.glTextureShape[1]]
        this.output = new Tensor([], this.outputShape)
        this.outputCopy = new Tensor([], this.outputShape)
        this.output.createGLTexture()
        this.outputCopy.createGLTexture()
      } else {
        this.outputShape = [timesteps, ...this.sliceOutput.originalShape]
        this.output = new Tensor([], this.outputShape)
        this.outputCopy = new Tensor([], this.outputShape)
        this.output.reshapeTo2DSquare()
        this.outputCopy.reshapeTo2DSquare()
        this.output.createGLTexture()
        this.outputCopy.createGLTexture()

        this._createOutputIndexMap(this.sliceOutput.indicesForReshaped)
      }
    }

    webgl2.runProgram({
      program: this.copyTextureProgram,
      output: this.outputCopy,
      inputs: [{ texture: this.output.glTexture, type: '2d', name: 'source' }]
    })

    if (this.inputShape.length <= 2) {
      webgl2.runProgram({
        program: this.copySliceOutputProgram,
        output: this.output,
        inputs: [
          { texture: this.outputCopy.glTexture, type: '2d', name: 'outputCopy' },
          { texture: this.sliceOutput.glTexture, type: '2d', name: 'sliceOutput' }
        ],
        uniforms: [{ value: 0, type: 'int', name: 't' }, { value: timesteps, type: 'int', name: 'timesteps' }]
      })
    } else {
      webgl2.runProgram({
        program: this.mapSliceOutputProgram,
        output: this.output,
        inputs: [
          { texture: this.outputCopy.glTexture, type: '2d', name: 'outputCopy' },
          { texture: this.sliceOutput.glTexture, type: '2d', name: 'sliceOutput' },
          { texture: this.outputRowIndexMaps[0].glTexture, type: '2d', name: 'rowIndexMap' },
          { texture: this.outputColIndexMaps[0].glTexture, type: '2d', name: 'colIndexMap' }
        ]
      })
    }

    for (let i = 1; i < timesteps; i++) {
      if (this.inputShape.length <= 2) {
        webgl2.runProgram({
          program: this.selectSliceProgram,
          output: this.slice,
          inputs: [{ texture: x.glTexture, type: '2d', name: 'x' }],
          uniforms: [{ value: i, type: 'int', name: 't' }]
        })
      } else {
        webgl2.runProgram({
          program: this.mapInputProgram,
          output: this.slice,
          inputs: [
            { texture: x.glTexture, type: '2d', name: 'x' },
            { texture: this.rowIndexMaps[i].glTexture, type: '2d', name: 'rowIndexMap' },
            { texture: this.colIndexMaps[i].glTexture, type: '2d', name: 'colIndexMap' }
          ]
        })
      }

      this.wrappedLayer._callGPU(this.slice)
      this.sliceOutput = this.wrappedLayer.output

      webgl2.runProgram({
        program: this.copyTextureProgram,
        output: this.outputCopy,
        inputs: [{ texture: this.output.glTexture, type: '2d', name: 'source' }]
      })

      if (this.inputShape.length <= 2) {
        webgl2.runProgram({
          program: this.copySliceOutputProgram,
          output: this.output,
          inputs: [
            { texture: this.outputCopy.glTexture, type: '2d', name: 'outputCopy' },
            { texture: this.sliceOutput.glTexture, type: '2d', name: 'sliceOutput' }
          ],
          uniforms: [{ value: i, type: 'int', name: 't' }, { value: timesteps, type: 'int', name: 'timesteps' }]
        })
      } else {
        webgl2.runProgram({
          program: this.mapSliceOutputProgram,
          output: this.output,
          inputs: [
            { texture: this.outputCopy.glTexture, type: '2d', name: 'outputCopy' },
            { texture: this.sliceOutput.glTexture, type: '2d', name: 'sliceOutput' },
            { texture: this.outputRowIndexMaps[i].glTexture, type: '2d', name: 'rowIndexMap' },
            { texture: this.outputColIndexMaps[i].glTexture, type: '2d', name: 'colIndexMap' }
          ]
        })
      }
    }

    // GPU -> CPU data transfer
    if (this.outbound.length === 0) {
      this.output.transferFromGLTexture()
      if (this.output.is2DReshaped) {
        this.output.reshapeFrom2DSquare()
      }
    }
  }
}
