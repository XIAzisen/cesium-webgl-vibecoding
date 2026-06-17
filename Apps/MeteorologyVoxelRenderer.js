/**
 * Cesium 气象云体渲染器
 * 基于 Cesium VoxelPrimitive 的气象雷达体渲染系统
 * 用法:
 *   const renderer = new MeteorologyVoxelRenderer({
 *     viewer: viewer,
 *     data: volData,
 *     bounds: { west, east, south, north, minH, maxH }
 *   });
 *   renderer.createVoxel();
 */
class MeteorologyVoxelRenderer {
  // ================================================================
  //  构造 & 销毁
  // ================================================================
  constructor(options) {
    this.viewer = options.viewer;
    this.data = options.data;
    this.bounds = options.bounds || {
      west: 110, east: 120, south: 35, north: 45, minH: 0, maxH: 15000
    };

    // 渲染状态
    this.voxelPrimitive = null;
    this.voxelProvider = null;
    this.isoPrimitive = null;
    this.currentMode = 'voxel';           // 'voxel' | 'isosurface'
    this.colorScheme = 'cloud';           // 'cloud' | 'rain' | 'heat'
    this.threshold = 20;
    this.alpha = 0.70;
    this.timeStepCount = 24;
    this.timeStepsData = [];
    this.currentTimeStep = 0;

    // 动画状态
    this.isAnimating = false;
    this.animationSpeed = 5;
    this.animationFrameId = null;
    this.lastFrameTime = 0;
    this.animationProgress = 0;

    // 内部状态
    this._rebuildTimer = null;
    this._verboseLog = true;
    this._forceRebuildNext = false;

    // 常量
    this._sampleFactor = 4;
    this._shapeType = Cesium.VoxelShapeType.BOX;
  }

  // ================================================================
  //  公开 API
  // ================================================================

  /** 创建体渲染（默认 voxel 模式） */
  createVoxel() {
    this._destroyVoxel();
    this.voxelProvider = this._createVoxelProvider(this.data);
    const shader = this._createShader();

    this.voxelPrimitive = this.viewer.scene.primitives.add(
      new Cesium.VoxelPrimitive({
        provider: this.voxelProvider,
        customShader: shader
      })
    );

    this._addVoxelInspector();
    this._flyToBounds();
    this._fireReady();
  }

  /** 切换到等值面模式 */
  createIsoSurface() {
    this._destroyIsoSurface();
    const { positions, colors, indices } = this._marchingCubes(this.threshold);

    if (positions.length === 0) return;

    const geometry = new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.DOUBLE,
          componentsPerAttribute: 3,
          values: new Float64Array(positions)
        }),
        color: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 4,
          values: new Float32Array(colors)
        })
      },
      indices: new Uint32Array(indices),
      primitiveType: Cesium.PrimitiveType.TRIANGLES,
      boundingSphere: Cesium.BoundingSphere.fromVertices(positions)
    });

    this.isoPrimitive = this.viewer.scene.primitives.add(new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({ geometry }),
      appearance: new Cesium.PerInstanceColorAppearance({
        flat: false, translucent: true,
        renderState: {
          depthTest: { enabled: true }, depthMask: false,
          blending: Cesium.BlendingState.ALPHA_BLEND
        }
      }),
      asynchronous: false
    }));

    this._flyToBounds();
    this._fireReady();
  }

  /** 切换渲染模式 */
  setRenderMode(mode) {
    this.currentMode = mode;
    if (mode === 'voxel') this.createVoxel();
    else this.createIsoSurface();
  }

  /** 设置颜色方案 */
  setColorScheme(scheme) {
    this.colorScheme = scheme;
    this._scheduleRebuild();
  }

  /** 设置阈值 */
  setThreshold(value) {
    this.threshold = value;
    this._scheduleRebuild();
  }

  /** 设置透明度 */
  setAlpha(value) {
    this.alpha = value;
    this._scheduleRebuild();
  }

  /** 切换时间步 */
  setTimeStep(step) {
    this.currentTimeStep = Math.max(0, Math.min(this.timeStepCount - 1, step));
    if (this.voxelPrimitive) this._updateVoxelData();
  }

  /** 设置动画速度 */
  setAnimationSpeed(speed) {
    this.animationSpeed = speed;
    if (this.isAnimating) {
      this.stopAnimation();
      this.startAnimation();
    }
  }

  /** 开始动画 */
  startAnimation() {
    if (this.isAnimating) return;
    this.isAnimating = true;
    this.lastFrameTime = performance.now();
    this.animationProgress = 0;
    this._verboseLog = false;
    this._animationLoop();
  }

  /** 停止动画 */
  stopAnimation() {
    this.isAnimating = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    this.animationProgress = 0;
    this._verboseLog = true;
  }

  /** 切换动画播放/暂停 */
  toggleAnimation() {
    if (this.isAnimating) this.stopAnimation();
    else this.startAnimation();
  }

  /** 重置时间步 */
  resetTimeStep() {
    this.stopAnimation();
    this.setTimeStep(0);
  }

  /** 加载数据（替换当前数据） */
  setData(data) {
    this.data = data;
    if (data.xmin !== undefined) {
      this.bounds.west = data.xmin;
      this.bounds.east = data.xmax;
      this.bounds.south = data.ymin;
      this.bounds.north = data.ymax;
      this.bounds.minH = data.zmin;
      this.bounds.maxH = data.zmax;
    }
    this._generateTimeSteps();
    this._scheduleRebuild();
  }

  /** 销毁资源 */
  destroy() {
    this.stopAnimation();
    this._destroyVoxel();
    this._destroyIsoSurface();
    this.timeStepsData = [];
  }

  /** 获取当前颜色值（用于图例） */
  getColor(value, maxVal = 60) {
    return MeteorologyVoxelRenderer.getColor(value, maxVal, this.colorScheme);
  }

  // ================================================================
  //  静态工具方法
  // ================================================================

  /** 静态颜色映射（不依赖实例） */
  static getColor(value, maxVal = 60, scheme = 'cloud') {
    const v = Math.max(0, Math.min(1, value / maxVal));
    let r, g, b;
    if (scheme === 'cloud') {
      r = Math.round(180 + v * 75);
      g = Math.round(200 + v * 55);
      b = 255;
    } else if (scheme === 'rain') {
      if (v < 0.2)      { r = 0; g = 200; b = 0; }
      else if (v < 0.4) { r = 0; g = 255; b = 0; }
      else if (v < 0.5) { r = 128; g = 255; b = 0; }
      else if (v < 0.6) { r = 255; g = 255; b = 0; }
      else if (v < 0.7) { r = 255; g = 180; b = 0; }
      else if (v < 0.8) { r = 255; g = 0; b = 0; }
      else if (v < 0.9) { r = 180; g = 0; b = 100; }
      else              { r = 180; g = 0; b = 180; }
    } else {
      if (v < 0.33)     { r = v * 3 * 200; g = 0; b = 0; }
      else if (v < 0.66){ r = 200 + (v - 0.33) * 3 * 55; g = (v - 0.33) * 3 * 200; b = 0; }
      else              { r = 255; g = 200 + (v - 0.66) * 3 * 55; b = (v - 0.66) * 3 * 255; }
    }
    return { r: Math.min(255, r), g: Math.min(255, g), b: Math.min(255, b) };
  }

  /** 从 URL 加载体数据 */
  static async loadFromUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    return resp.json();
  }

  // ================================================================
  //  私有 - 数据生成
  // ================================================================

  _generateTimeSteps() {
    const { cols, rows, heights, values } = this.data;
    const size = cols * rows * heights;

    this.timeStepsData = [];

    // 预生成噪声场（用于平滑演变）
    const noiseField = new Float32Array(size);
    for (let i = 0; i < size; i++) noiseField[i] = Math.random() * 2 - 1;

    for (let t = 0; t < this.timeStepCount; t++) {
      const stepValues = new Float32Array(size);
      const timePhase = t / this.timeStepCount;
      const intensityWave = Math.sin(timePhase * Math.PI * 2);
      const growthFactor = 1 + intensityWave * 0.3;
      const noiseWeight = 0.15 * Math.sin(timePhase * Math.PI);

      for (let k = 0; k < heights; k++) {
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            const idx = k * rows * cols + j * cols + i;
            let val = values[idx];
            if (val > 0) {
              val *= growthFactor;
              val += noiseField[idx] * noiseWeight * val;
              val = Math.max(0, val);
            }
            stepValues[idx] = val;
          }
        }
      }
      this.timeStepsData.push(stepValues);
    }
  }

  _getCurrentTimeStepData() {
    return this.timeStepsData.length > 0
      ? this.timeStepsData[this.currentTimeStep]
      : this.data.values;
  }

  // ================================================================
  //  私有 - VoxelProvider
  // ================================================================

  _createVoxelProvider(data) {
    const sf = this._sampleFactor;
    const dims = {
      x: Math.ceil(data.cols / sf),
      y: Math.ceil(data.rows / sf),
      z: Math.ceil(data.heights / 2)
    };
    const voxelCount = dims.x * dims.y * dims.z;
    const currentValues = this._getCurrentTimeStepData();

    const intensityData = new Float32Array(voxelCount);
    let idx = 0;
    for (let k = 0; k < dims.z; k++) {
      for (let j = 0; j < dims.y; j++) {
        for (let i = 0; i < dims.x; i++) {
          const srcI = Math.min(i * sf, data.cols - 1);
          const srcJ = Math.min(j * sf, data.rows - 1);
          const srcK = Math.min(k * 2, data.heights - 1);
          const srcIdx = srcK * data.rows * data.cols + srcJ * data.cols + srcI;
          intensityData[idx++] = currentValues[srcIdx];
        }
      }
    }

    const b = this.bounds;
    const westRad = Cesium.Math.toRadians(b.west);
    const eastRad = Cesium.Math.toRadians(b.east);
    const southRad = Cesium.Math.toRadians(b.south);
    const northRad = Cesium.Math.toRadians(b.north);

    const geoWidth = eastRad - westRad;
    const geoHeight = northRad - southRad;
    const altRange = b.maxH - b.minH;
    const altMid = (b.maxH + b.minH) / 2;
    const lonCenter = (westRad + eastRad) / 2;
    const latCenter = (southRad + northRad) / 2;
    const R = Cesium.Ellipsoid.WGS84.maximumRadius;

    const enuOrigin = Cesium.Cartesian3.fromRadians(lonCenter, latCenter, altMid);
    const enuToEcef = Cesium.Transforms.eastNorthUpToFixedFrame(enuOrigin);

    const halfLonRad = geoWidth / 2;
    const halfLatRad = geoHeight / 2;
    const halfAlt = altRange / 2;
    const eastScale = R * halfLonRad * Math.cos(latCenter);
    const northScale = R * halfLatRad;
    const upScale = halfAlt;

    const scaleMat = Cesium.Matrix4.fromScale(
      new Cesium.Cartesian3(eastScale, northScale, upScale)
    );
    let globalTransform = new Cesium.Matrix4();
    Cesium.Matrix4.multiplyTransformation(enuToEcef, scaleMat, globalTransform);

    const provider = new MeteorologyVoxelProvider({
      shape: this._shapeType,
      minBounds: new Cesium.Cartesian3(-1, -1, -1),
      maxBounds: new Cesium.Cartesian3(1, 1, 1),
      dimensions: new Cesium.Cartesian3(dims.x, dims.y, dims.z),
      globalTransform,
      intensityData,
      verboseLog: this._verboseLog
    });

    return provider;
  }

  // ================================================================
  //  私有 - Shader
  // ================================================================

  _createShader() {
    const isTestMode = window.TEST_VOXEL === 1;
    const threshold = Math.max(0, this.threshold - 15);

    if (isTestMode) {
      return new Cesium.CustomShader({
        fragmentShaderText: `
          void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
            material.diffuse = vec3(1.0, 1.0, 1.0);
            material.alpha = 0.8;
          }
        `
      });
    }

    return new Cesium.CustomShader({
      fragmentShaderText: `
        void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
          float intensity = fsInput.metadata.intensity;

          float threshold = ${threshold.toFixed(1)};
          float rangeVal = 60.0 - threshold;

          float normalized = clamp((intensity - threshold) / rangeVal, 0.0, 1.0);
          float visibility = smoothstep(threshold - 5.0, threshold + 10.0, intensity);

          vec3 color;
          ${this._getColorFunctionGLSL()}

          material.diffuse = color;
          material.alpha = visibility * ${this.alpha.toFixed(2)};
        }
      `
    });
  }

  _getColorFunctionGLSL() {
    const s = this.colorScheme;
    if (s === 'cloud') {
      return `
        float t = normalized;
        color.r = 0.706 + t * 0.294;
        color.g = 0.784 + t * 0.216;
        color.b = 1.0;
      `;
    } else if (s === 'rain') {
      return `
        float t = normalized;
        vec3 c0 = vec3(0.0, 0.784, 0.0);
        vec3 c1 = vec3(0.502, 1.0, 0.0);
        vec3 c2 = vec3(1.0, 1.0, 0.0);
        vec3 c3 = vec3(1.0, 0.5, 0.0);
        vec3 c4 = vec3(1.0, 0.0, 0.0);
        vec3 c5 = vec3(0.7, 0.0, 0.392);
        vec3 c6 = vec3(0.7, 0.0, 0.7);
        float s = t * 5.0;
        float i = floor(s);
        float f = fract(s);
        if (i < 1.0) { color = mix(c0, c1, f); }
        else if (i < 2.0) { color = mix(c1, c2, f); }
        else if (i < 3.0) { color = mix(c2, c3, f); }
        else if (i < 4.0) { color = mix(c3, c4, f); }
        else { color = mix(c4, c5 + (c6 - c5) * f, f); }
      `;
    } else {
      return `
        float t = normalized;
        color.r = 1.0;
        color.g = clamp(t / 0.67, 0.0, 1.0) * 0.9;
        color.b = max(0.0, (t - 0.67) / 0.33) * 1.0;
      `;
    }
  }

  // ================================================================
  //  私有 - Marching Cubes
  // ================================================================

  _marchingCubes(threshold) {
    const data = this.data;
    const b = this.bounds;
    const positions = [];
    const colors = [];
    const indices = [];

    const resX = 50, resY = 50, resZ = 20;
    const dLon = (b.east - b.west) / resX;
    const dLat = (b.north - b.south) / resY;
    const dH = (b.maxH - b.minH) / resZ;

    let vertCount = 0;

    // MC 查表
    const CUBE_VERTS = [
      [0,0,0],[1,0,0],[1,1,0],[0,1,0],
      [0,0,1],[1,0,1],[1,1,1],[0,1,1]
    ];
    const CUBE_EDGES = [
      [0,1],[1,2],[2,3],[3,0],
      [4,5],[5,6],[6,7],[7,4],
      [0,4],[1,5],[2,6],[3,7]
    ];
    const MC_TRI_TABLE = this._genMCTriTable();

    for (let i = 0; i < resX; i++) {
      for (let j = 0; j < resY; j++) {
        for (let k = 0; k < resZ; k++) {
          const lon0 = b.west + i * dLon;
          const lat0 = b.north - j * dLat;
          const h0 = b.minH + k * dH;

          const vals = [];
          let validCount = 0, avgVal = 0;
          for (let v = 0; v < 8; v++) {
            const dv = CUBE_VERTS[v];
            const val = this._sampleVolume(
              data, b, lon0 + dv[0] * dLon, lat0 - dv[1] * dLat, h0 + dv[2] * dH
            );
            vals.push(val);
            if (val >= 0) { validCount++; avgVal += val; }
          }
          if (validCount < 4) continue;
          avgVal /= validCount;

          let cubeIndex = 0;
          for (let v = 0; v < 8; v++) {
            if (vals[v] >= threshold) cubeIndex |= (1 << v);
          }
          if (cubeIndex === 0 || cubeIndex === 255) continue;

          const tris = MC_TRI_TABLE[cubeIndex];
          if (!tris || tris.length < 3) continue;

          const edgeVerts = [];
          for (let e = 0; e < 12; e++) {
            const [v1, v2] = CUBE_EDGES[e];
            if ((vals[v1] >= threshold) !== (vals[v2] >= threshold)) {
              const t = (threshold - vals[v1]) / (vals[v2] - vals[v1]);
              const p1 = CUBE_VERTS[v1], p2 = CUBE_VERTS[v2];
              edgeVerts[e] = {
                lon: lon0 + (p1[0] + t * (p2[0] - p1[0])) * dLon,
                lat: lat0 - (p1[1] + t * (p2[1] - p1[1])) * dLat,
                h: h0 + (p1[2] + t * (p2[2] - p1[2])) * dH
              };
            }
          }

          for (let t = 0; t < tris.length; t += 3) {
            const v0 = edgeVerts[tris[t]], v1 = edgeVerts[tris[t + 1]], v2 = edgeVerts[tris[t + 2]];
            if (!v0 || !v1 || !v2) continue;

            const p0 = Cesium.Cartesian3.fromDegrees(v0.lon, v0.lat, v0.h);
            const p1 = Cesium.Cartesian3.fromDegrees(v1.lon, v1.lat, v1.h);
            const p2 = Cesium.Cartesian3.fromDegrees(v2.lon, v2.lat, v2.h);

            positions.push(p0.x, p0.y, p0.z);
            positions.push(p1.x, p1.y, p1.z);
            positions.push(p2.x, p2.y, p2.z);

            const col = MeteorologyVoxelRenderer.getColor(avgVal);
            for (let c = 0; c < 3; c++) {
              colors.push(col.r / 255, col.g / 255, col.b / 255, this.alpha);
            }
            indices.push(vertCount, vertCount + 1, vertCount + 2);
            vertCount += 3;
          }
        }
      }
    }
    return { positions, colors, indices };
  }

  _genMCTriTable() {
    const CUBE_VERTS = [
      [0,0,0],[1,0,0],[1,1,0],[0,1,0],
      [0,0,1],[1,0,1],[1,1,1],[0,1,1]
    ];
    const CUBE_EDGES = [
      [0,1],[1,2],[2,3],[3,0],
      [4,5],[5,6],[6,7],[7,4],
      [0,4],[1,5],[2,6],[3,7]
    ];
    const table = [];
    for (let idx = 0; idx < 256; idx++) {
      const tris = [];
      const edges = [];
      for (let e = 0; e < 12; e++) {
        const b1 = (idx >> CUBE_EDGES[e][0]) & 1;
        const b2 = (idx >> CUBE_EDGES[e][1]) & 1;
        if (b1 !== b2) edges.push(e);
      }
      if (edges.length >= 3) {
        for (let t = 1; t < edges.length - 1; t++) {
          tris.push(edges[0], edges[t], edges[t + 1]);
        }
      }
      table[idx] = tris;
    }
    return table;
  }

  _sampleVolume(data, b, lon, lat, alt) {
    const fi = (lon - b.west) / (b.east - b.west) * (data.cols - 1);
    const fj = (b.north - lat) / (b.north - b.south) * (data.rows - 1);
    const fk = (alt - b.minH) / (b.maxH - b.minH) * (data.heights - 1);
    if (fi < 0 || fi >= data.cols - 1 || fj < 0 || fj >= data.rows - 1 || fk < 0 || fk >= data.heights - 1) return -1;

    const i0 = Math.floor(fi), j0 = Math.floor(fj), k0 = Math.floor(fk);
    const tx = fi - i0, ty = fj - j0, tz = fk - k0;
    const idx = (k, j, i) => k * data.rows * data.cols + j * data.cols + i;

    const v000 = data.values[idx(k0, j0, i0)];
    const v100 = data.values[idx(k0, j0, i0 + 1)];
    const v010 = data.values[idx(k0, j0 + 1, i0)];
    const v110 = data.values[idx(k0, j0 + 1, i0 + 1)];
    const v001 = data.values[idx(k0 + 1, j0, i0)];
    const v101 = data.values[idx(k0 + 1, j0, i0 + 1)];
    const v011 = data.values[idx(k0 + 1, j0 + 1, i0)];
    const v111 = data.values[idx(k0 + 1, j0 + 1, i0 + 1)];

    if (v000 < 0 || v100 < 0 || v010 < 0 || v110 < 0 || v001 < 0 || v101 < 0 || v011 < 0 || v111 < 0) return -1;

    const c00 = v000 * (1 - tx) + v100 * tx;
    const c01 = v001 * (1 - tx) + v101 * tx;
    const c10 = v010 * (1 - tx) + v110 * tx;
    const c11 = v011 * (1 - tx) + v111 * tx;

    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
  }

  // ================================================================
  //  私有 - 数据更新
  // ================================================================

  _updateVoxelData() {
    if (!this.voxelPrimitive || !this.voxelPrimitive._ready || !this.voxelProvider) return;

    const currentValues = this._getCurrentTimeStepData();
    const sf = this._sampleFactor;
    const dims = this.voxelProvider.dimensions;
    const voxelCount = dims.x * dims.y * dims.z;

    const newData = new Float32Array(voxelCount);
    let idx = 0;
    for (let k = 0; k < dims.z; k++) {
      for (let j = 0; j < dims.y; j++) {
        for (let i = 0; i < dims.x; i++) {
          const srcI = Math.min(i * sf, this.data.cols - 1);
          const srcJ = Math.min(j * sf, this.data.rows - 1);
          const srcK = Math.min(k * 2, this.data.heights - 1);
          const srcIdx = srcK * this.data.rows * this.data.cols + srcJ * this.data.cols + srcI;
          newData[idx++] = currentValues[srcIdx];
        }
      }
    }

    this.voxelProvider.intensityData = newData;

    try {
      const traversal = this.voxelPrimitive._traversal;
      if (traversal && traversal.megatextures && traversal.megatextures.length > 0) {
        traversal.megatextures[0].writeDataToTexture(0, newData);
        this.viewer.scene.requestRender();
      }
    } catch (err) {
      console.warn('Megatexture update failed:', err);
    }
  }

  // ================================================================
  //  私有 - 生命周期
  // ================================================================

  _scheduleRebuild() {
    if (this._rebuildTimer) clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => {
      this._rebuildTimer = null;
      if (this.currentMode === 'voxel') this.createVoxel();
      else this.createIsoSurface();
    }, 300);
  }

  _destroyVoxel() {
    if (this.voxelPrimitive) {
      this.viewer.scene.primitives.remove(this.voxelPrimitive);
      this.voxelPrimitive = null;
      this.voxelProvider = null;
    }
  }

  _destroyIsoSurface() {
    if (this.isoPrimitive) {
      this.viewer.scene.primitives.remove(this.isoPrimitive);
      this.isoPrimitive = null;
    }
  }

  _addVoxelInspector() {
    if (!this.viewer._voxelInspectorAdded) {
      this.viewer.extend(Cesium.viewerVoxelInspectorMixin);
      this.viewer._voxelInspectorAdded = true;
    }
    this.viewer.scene.debugShowFramesPerSecond = true;
  }

  _flyToBounds() {
    const b = this.bounds;
    const centerLon = (b.west + b.east) / 2;
    const centerLat = (b.south + b.north) / 2;
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, 600000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-30), roll: 0 }
    });
  }

  _fireReady() {
    this.viewer.scene.requestRender();
    setTimeout(() => this.viewer.scene.requestRender(), 500);
  }

  // ================================================================
  //  私有 - 动画循环
  // ================================================================

  _animationLoop() {
    if (!this.isAnimating) return;

    const now = performance.now();
    const deltaTime = now - this.lastFrameTime;
    this.lastFrameTime = now;

    const stepDuration = 1000 / this.animationSpeed;
    this.animationProgress += deltaTime / stepDuration;

    if (this.animationProgress >= 1) {
      this.animationProgress = 0;
      this.currentTimeStep = (this.currentTimeStep + 1) % this.timeStepCount;
      if (this.voxelPrimitive) this._updateVoxelData();
    }

    this.animationFrameId = requestAnimationFrame(() => this._animationLoop());
  }
}

// ================================================================
//  VoxelProvider 类（内部使用）
// ================================================================

class MeteorologyVoxelProvider {
  constructor(options) {
    this.shape = options.shape;
    this.minBounds = options.minBounds;
    this.maxBounds = options.maxBounds;
    this.dimensions = options.dimensions;
    // VoxelTraversal 需要这些字段
    this.names = ['intensity'];
    this.types = [Cesium.MetadataType.SCALAR];
    this.componentTypes = [Cesium.MetadataComponentType.FLOAT32];
    this.globalTransform = options.globalTransform;
    this.intensityData = options.intensityData;
    this.availableLevels = 1;
    this.verboseLog = options.verboseLog;
  }

  requestData(options) {
    if (this.verboseLog) console.log('requestData tileLevel:', options.tileLevel);

    if (options.tileLevel >= 1) {
      return Promise.reject('No tiles at this level');
    }

    const dimensions = this.dimensions;
    const voxelCount = dimensions.x * dimensions.y * dimensions.z;
    const data = new Float32Array(voxelCount);

    for (let i = 0; i < voxelCount; i++) {
      data[i] = this.intensityData[i];
    }

    const content = new Cesium.VoxelContent({ metadata: [data] });
    return Promise.resolve(content);
  }
}