/**
 * Cesium GPGPU 水波模拟
 * 参考 Three.js webgl_gpgpu_water 示例
 * 
 * 核心原理：
 * 1. 使用两个纹理存储高度场（ping-pong 缓冲）
 * 2. GPU 计算每个像素的下一帧高度（波动方程）
 * 3. 法线贴图从高度场计算水面法线
 * 4. 最终渲染应用反射/折射
 * 
 * 用法：
 *   const waterSim = new CesiumWaterSimulation({
 *     viewer,
 *     width: 512,
 *     height: 512
 *   });
 *   waterSim.start();
 */
class CesiumWaterSimulation {
  constructor(options) {
    this.viewer = options.viewer;
    this.width = options.width || 256;
    this.height = options.height || 256;
    this.container = options.container || viewer.container;
    
    // 模拟参数
    this.dampening = 0.99;      // 阻尼系数
    this.speed = 0.3;           // 波速
    this.dropRadius = 0.03;     // 涟漪半径
    this.dropStrength = 0.5;    // 涟漪强度
    
    // WebGL 资源
    this.gl = null;
    this.quadVAO = null;
    this.heightFBOs = [null, null];  // ping-pong FBO
    this.heightTextures = [null, null];
    this.normalFBO = null;
    this.normalTexture = null;
    this.currentRead = 0;
    
    // Shader 程序
    this.simulateProgram = null;
    this.dropProgram = null;
    this.normalProgram = null;
    this.renderProgram = null;
    
    // 交互
    this.mousePos = { x: -1, y: -1 };
    this.lastMousePos = { x: -1, y: -1 };
    this.mouseDown = false;
    
    // 状态
    this.started = false;
    this._bindedUpdate = null;
  }
  
  // ================================================================
  //  初始化
  // ================================================================
  
  start() {
    if (this.started) return;
    this.started = true;
    
    // 获取 Cesium 的 WebGL 上下文
    const context = this.viewer.scene.context;
    this.gl = context._gl;
    
    // 初始化 WebGL 资源
    this._initQuad();
    this._initTextures();
    this._initShaders();
    this._initInteraction();
    
    // 添加到渲染循环
    this._bindedUpdate = this._update.bind(this);
    this.viewer.scene.preRender.addEventListener(this._bindedUpdate);
    
    console.log('CesiumWaterSimulation started');
  }
  
  stop() {
    if (!this.started) return;
    this.started = false;
    
    if (this._bindedUpdate) {
      this.viewer.scene.preRender.removeEventListener(this._bindedUpdate);
      this._bindedUpdate = null;
    }
    
    this._removeInteraction();
    this._destroyResources();
  }
  
  // ================================================================
  //  WebGL 初始化
  // ================================================================
  
  _initQuad() {
    const gl = this.gl;
    
    // 全屏四边形顶点
    const vertices = new Float32Array([
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
       1,  1, 1, 1
    ]);
    
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    
    this.quadVBO = vbo;
    this.quadAttribs = {
      position: 0,
      uv: 1
    };
  }
  
  _initTextures() {
    const gl = this.gl;
    const w = this.width;
    const h = this.height;
    
    // 创建两个高度场纹理（ping-pong）
    for (let i = 0; i < 2; i++) {
      this.heightTextures[i] = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.heightTextures[i]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F || gl.RGBA, w, h, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      
      this.heightFBOs[i] = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.heightFBOs[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.heightTextures[i], 0);
    }
    
    // 法线贴图纹理
    this.normalTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.normalTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    
    this.normalFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.normalFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.normalTexture, 0);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  
  _initShaders() {
    const gl = this.gl;
    
    // 波动模拟 shader
    this.simulateProgram = this._createProgram(
      // Vertex
      `
        attribute vec2 aPosition;
        attribute vec2 aUV;
        varying vec2 vUV;
        void main() {
          vUV = aUV;
          gl_Position = vec4(aPosition, 0.0, 1.0);
        }
      `,
      // Fragment
      `
        precision highp float;
        uniform sampler2D uHeightMap;
        uniform vec2 uResolution;
        uniform float uDampening;
        uniform float uSpeed;
        varying vec2 vUV;
        
        void main() {
          vec2 texel = 1.0 / uResolution;
          
          // 采样周围像素
          float current = texture2D(uHeightMap, vUV).r;
          float left = texture2D(uHeightMap, vUV - vec2(texel.x, 0.0)).r;
          float right = texture2D(uHeightMap, vUV + vec2(texel.x, 0.0)).r;
          float top = texture2D(uHeightMap, vUV + vec2(0.0, texel.y)).r;
          float bottom = texture2D(uHeightMap, vUV - vec2(0.0, texel.y)).r;
          
          // 波动方程：next = 2*current - previous + speed * laplacian
          // 简化版：next = current + speed * (avg - current)
          float avg = (left + right + top + bottom) * 0.25;
          float next = current + uSpeed * (avg - current);
          
          // 阻尼衰减
          next *= uDampening;
          
          gl_FragColor = vec4(next, 0.0, 0.0, 1.0);
        }
      `
    );
    
    // 涟漪添加 shader
    this.dropProgram = this._createProgram(
      `
        attribute vec2 aPosition;
        attribute vec2 aUV;
        varying vec2 vUV;
        void main() {
          vUV = aUV;
          gl_Position = vec4(aPosition, 0.0, 1.0);
        }
      `,
      `
        precision highp float;
        uniform sampler2D uHeightMap;
        uniform vec2 uCenter;
        uniform float uRadius;
        uniform float uStrength;
        varying vec2 vUV;
        
        void main() {
          float current = texture2D(uHeightMap, vUV).r;
          float dist = distance(vUV, uCenter);
          float drop = smoothstep(uRadius, 0.0, dist) * uStrength;
          gl_FragColor = vec4(current + drop, 0.0, 0.0, 1.0);
        }
      `
    );
    
    // 法线计算 shader
    this.normalProgram = this._createProgram(
      `
        attribute vec2 aPosition;
        attribute vec2 aUV;
        varying vec2 vUV;
        void main() {
          vUV = aUV;
          gl_Position = vec4(aPosition, 0.0, 1.0);
        }
      `,
      `
        precision highp float;
        uniform sampler2D uHeightMap;
        uniform vec2 uResolution;
        varying vec2 vUV;
        
        void main() {
          vec2 texel = 1.0 / uResolution;
          
          float left = texture2D(uHeightMap, vUV - vec2(texel.x, 0.0)).r;
          float right = texture2D(uHeightMap, vUV + vec2(texel.x, 0.0)).r;
          float top = texture2D(uHeightMap, vUV + vec2(0.0, texel.y)).r;
          float bottom = texture2D(uHeightMap, vUV - vec2(0.0, texel.y)).r;
          
          // 计算法线
          vec3 normal = normalize(vec3(
            (left - right) * 2.0,
            (bottom - top) * 2.0,
            0.1
          ));
          
          // 映射到 [0,1]
          normal = normal * 0.5 + 0.5;
          
          gl_FragColor = vec4(normal, 1.0);
        }
      `
    );
  }
  
  _createProgram(vertexSource, fragmentSource) {
    const gl = this.gl;
    
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vertexSource);
    gl.compileShader(vs);
    
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('Vertex shader error:', gl.getShaderInfoLog(vs));
      return null;
    }
    
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fragmentSource);
    gl.compileShader(fs);
    
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('Fragment shader error:', gl.getShaderInfoLog(fs));
      return null;
    }
    
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    
    gl.bindAttribLocation(program, 0, 'aPosition');
    gl.bindAttribLocation(program, 1, 'aUV');
    
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(program));
      return null;
    }
    
    return {
      program,
      uniforms: this._getUniforms(gl, program)
    };
  }
  
  _getUniforms(gl, program) {
    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      uniforms[info.name] = gl.getUniformLocation(program, info.name);
    }
    return uniforms;
  }
  
  // ================================================================
  //  交互
  // ================================================================
  
  _initInteraction() {
    this._mouseMoveHandler = (e) => this._onMouseMove(e);
    this._mouseDownHandler = (e) => this._onMouseDown(e);
    this._mouseUpHandler = (e) => this._onMouseUp(e);
    
    const canvas = this.viewer.canvas;
    canvas.addEventListener('mousemove', this._mouseMoveHandler);
    canvas.addEventListener('mousedown', this._mouseDownHandler);
    canvas.addEventListener('mouseup', this._mouseUpHandler);
  }
  
  _removeInteraction() {
    const canvas = this.viewer.canvas;
    if (this._mouseMoveHandler) canvas.removeEventListener('mousemove', this._mouseMoveHandler);
    if (this._mouseDownHandler) canvas.removeEventListener('mousedown', this._mouseDownHandler);
    if (this._mouseUpHandler) canvas.removeEventListener('mouseup', this._mouseUpHandler);
  }
  
  _onMouseMove(e) {
    const rect = this.viewer.canvas.getBoundingClientRect();
    this.mousePos.x = (e.clientX - rect.left) / rect.width;
    this.mousePos.y = 1.0 - (e.clientY - rect.top) / rect.height;
    
    // 鼠标移动时产生涟漪
    if (this.mouseDown) {
      this.addDrop(this.mousePos.x, this.mousePos.y, this.dropRadius, this.dropStrength * 0.1);
    }
  }
  
  _onMouseDown(e) {
    this.mouseDown = true;
    // 点击产生强涟漪
    this.addDrop(this.mousePos.x, this.mousePos.y, this.dropRadius, this.dropStrength);
  }
  
  _onMouseUp(e) {
    this.mouseDown = false;
  }
  
  // ================================================================
  //  模拟 API
  // ================================================================
  
  /**
   * 添加涟漪
   */
  addDrop(x, y, radius, strength) {
    if (!this.started) return;
    
    const gl = this.gl;
    const readIdx = this.currentRead;
    const writeIdx = 1 - this.currentRead;
    
    // 使用 additive blending 叠加涟漪
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.heightFBOs[writeIdx]);
    gl.viewport(0, 0, this.width, this.height);
    
    gl.useProgram(this.dropProgram.program);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTextures[readIdx]);
    gl.uniform1i(this.dropProgram.uniforms.uHeightMap, 0);
    
    gl.uniform2f(this.dropProgram.uniforms.uCenter, x, y);
    gl.uniform1f(this.dropProgram.uniforms.uRadius, radius);
    gl.uniform1f(this.dropProgram.uniforms.uStrength, strength);
    
    this._drawQuad();
    
    // 切换缓冲
    this.currentRead = writeIdx;
  }
  
  /**
   * 获取当前高度纹理（用于渲染）
   */
  getHeightTexture() {
    return this.heightTextures[this.currentRead];
  }
  
  /**
   * 获取法线纹理
   */
  getNormalTexture() {
    return this.normalTexture;
  }
  
  // ================================================================
  //  每帧更新
  // ================================================================
  
  _update() {
    if (!this.started) return;
    
    const gl = this.gl;
    const readIdx = this.currentRead;
    const writeIdx = 1 - this.currentRead;
    
    // 保存当前状态
    const oldFBO = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const oldViewport = gl.getParameter(gl.VIEWPORT);
    const oldProgram = gl.getParameter(gl.CURRENT_PROGRAM);
    
    // 1. 波动模拟
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.heightFBOs[writeIdx]);
    gl.viewport(0, 0, this.width, this.height);
    
    gl.useProgram(this.simulateProgram.program);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTextures[readIdx]);
    gl.uniform1i(this.simulateProgram.uniforms.uHeightMap, 0);
    gl.uniform2f(this.simulateProgram.uniforms.uResolution, this.width, this.height);
    gl.uniform1f(this.simulateProgram.uniforms.uDampening, this.dampening);
    gl.uniform1f(this.simulateProgram.uniforms.uSpeed, this.speed);
    
    this._drawQuad();
    
    // 2. 计算法线
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.normalFBO);
    gl.viewport(0, 0, this.width, this.height);
    
    gl.useProgram(this.normalProgram.program);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTextures[writeIdx]);
    gl.uniform1i(this.normalProgram.uniforms.uHeightMap, 0);
    gl.uniform2f(this.normalProgram.uniforms.uResolution, this.width, this.height);
    
    this._drawQuad();
    
    // 切换 ping-pong 缓冲
    this.currentRead = writeIdx;
    
    // 恢复状态
    gl.bindFramebuffer(gl.FRAMEBUFFER, oldFBO);
    gl.viewport(oldViewport[0], oldViewport[1], oldViewport[2], oldViewport[3]);
    gl.useProgram(oldProgram);
  }
  
  _drawQuad() {
    const gl = this.gl;
    
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVBO);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    
    gl.disableVertexAttribArray(0);
    gl.disableVertexAttribArray(1);
  }
  
  // ================================================================
  //  清理
  // ================================================================
  
  _destroyResources() {
    const gl = this.gl;
    if (!gl) return;
    
    if (this.quadVBO) gl.deleteBuffer(this.quadVBO);
    for (let i = 0; i < 2; i++) {
      if (this.heightTextures[i]) gl.deleteTexture(this.heightTextures[i]);
      if (this.heightFBOs[i]) gl.deleteFramebuffer(this.heightFBOs[i]);
    }
    if (this.normalTexture) gl.deleteTexture(this.normalTexture);
    if (this.normalFBO) gl.deleteFramebuffer(this.normalFBO);
    
    [this.simulateProgram, this.dropProgram, this.normalProgram].forEach(p => {
      if (p && p.program) gl.deleteProgram(p.program);
    });
  }
  
  destroy() {
    this.stop();
  }
}
