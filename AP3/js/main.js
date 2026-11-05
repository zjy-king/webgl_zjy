/* ==========================================================================
 * main.js  ——  主渲染循环与交互
 * --------------------------------------------------------------------------
 * 每帧的渲染顺序：
 *   ① 第一遍：从光源渲染深度 → 阴影贴图
 *   ② 天空盒（只写颜色，深度恒为 1）
 *   ③ 不透明物体（写入深度）
 *   ④ 透明物体（按距离从远到近，开混合，不写深度）
 *   ⑤ 选中描边（放大壳，只画背面）
 *
 * 拾取是惰性的：只在鼠标点击时单独渲染一次 ID 缓冲，不占每帧开销。
 * ========================================================================== */
'use strict';

const App = (function(){

  let canvas = null;
  let gl = null;

  /* 全局状态：面板直接读写这个对象 */
  const state = {
    /* Phong 三分量开关（要求 2）*/
    useAmbient: true,
    useDiffuse: true,
    useSpecular: true,

    globalAmbient: 0.55,
    shadowEnabled: true,
    shadowMapSize: 1024,

    objects: null,
    lights: null,

    selectedId: 0,

    /* 相机 */
    /* 相机：站在房间内部朝 -Z 方向看桌子。
       房间 12×9×14，xz 中心在原点，所以相机 z 取正（房间前半部），
       高度略高于桌面，俯角约 18°，这样能看到桌面 + 地面上的投影。 */
    yaw: 0.34,
    pitch: 0.24,
    dist: 13.6,
    target: [0.2, 2.5, -0.9],

    /* E3 对比：全局用 Blinn 还是原始 Phong */
    useBlinn: false,

    /* 调试显示 */
    showIDBuffer: false
  };

  let programMain = null;
  let programOutline = null;
  let programSky = null;

  const vaoMap = {};       // geo key → { vao, count }
  let textures = {};       // texKey → WebGLTexture
  let envMap = null;
  let skyVAO = null;

  let viewMat = null;
  let projMat = null;
  let lightVPForVS = null;

  let lastTime = 0;
  let fpsAcc = 0, fpsFrames = 0;
  let dpr = 1;

  /* ======================================================================
   * 初始化
   * ====================================================================== */
  function init(){
    canvas = document.getElementById('glcanvas');
    gl = GL.init(canvas);

    state.objects = SCENE.objects.map(function(o){
      /* 深拷贝材质，避免面板修改污染原始 SCENE 定义 */
      const c = JSON.parse(JSON.stringify(o));
      return c;
    });
    state.lights = JSON.parse(JSON.stringify(SCENE.lights));

    /* --- 程序 --- */
    programMain = GL.buildProgram(SHADERS.mainVS, SHADERS.mainFS, [
      'uModelView', 'uProjection', 'uNormalMatrix',
      'uKa', 'uKd', 'uKs', 'uShininess', 'uReflect', 'uAlpha', 'uToon',
      'uUseAmbient', 'uUseDiffuse', 'uUseSpecular',
      'uEyePosVS', 'uGlobalAmbient',
      'uNumLights', 'uLightType', 'uLightPosVS', 'uLightDirVS',
      'uLightColor', 'uLightAtten',
      'uTex', 'uNormalMap', 'uEnvMap', 'uHasTex', 'uHasNormalMap', 'uUVScale',
      'uNormalStrength', 'uEnvMode',
      'uShadowMap', 'uLightVP', 'uShadowEnabled', 'uShadowTexel',
      'uShadowBias', 'uPCF', 'uShadowAmbient'
    ]);

    programOutline = GL.buildProgram(SHADERS.outlineVS, SHADERS.outlineFS,
      ['uModelView', 'uProjection', 'uNormalMatrix', 'uOutlineWidth', 'uColor']);

    programSky = GL.buildProgram(SHADERS.skyVS, SHADERS.skyFS,
      ['uProjection', 'uViewRotOnly', 'uEnvMap']);

    /* --- 几何体 --- */
    Object.keys(SCENE_GEOS).forEach(function(key){
      const geo = SCENE_GEOS[key]();
      vaoMap[key] = GL.uploadGeometry(geo, programMain.attrib);
    });

    /* 天空盒用一个大立方体 */
    const skyGeo = createCube();
    skyVAO = GL.uploadGeometry(skyGeo, programSky.attrib);

    /* --- 纹理 ---
       【重要】loadTexture 是异步的：它先返回占位纹理，图片到货后才建真正的纹理。
       所以这里必须用回调把新纹理写回 textures 表，否则 textures[key]
       永远指向那张 1×1 的占位图，所有物体都会变成纯色（本项目实际踩过这个坑）。 */
    const TEX_FILES = {
      wood:        'textures/wood.jpg',
      brick:       'textures/brick.jpg',
      brickNormal: 'textures/brick_normal.jpg',
      crate:       'textures/crate.jpg',
      floor:       'textures/floor.jpg'
    };
    Object.keys(TEX_FILES).forEach(function(key){
      textures[key] = GL.loadTexture(TEX_FILES[key], function(realTex){
        textures[key] = realTex;
      });
    });

    /* --- 环境贴图 --- */
    envMap = GL.loadCubemap([
      'textures/env_px.jpg', 'textures/env_nx.jpg',
      'textures/env_py.jpg', 'textures/env_ny.jpg',
      'textures/env_pz.jpg', 'textures/env_nz.jpg'
    ]);

    /* --- 阴影 & 拾取 --- */
    Shadow.init(gl);
    resize();

    Picker.init(gl, canvas.width, canvas.height);

    /* --- UI --- */
    UI.init(state, null);
    window.onShadowMapSizeChange = function(size){
      Shadow.setMapSize(size);
    };
    window.onPresetChanged = function(){
      UI.refreshAll();
    };

    bindEvents();

    /* --- 启动 --- */
    lastTime = performance.now();
    requestAnimationFrame(frame);
  }

  function resize(){
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    const panelW = 340;
    const w = Math.max(1, window.innerWidth - panelW);
    const h = Math.max(1, window.innerHeight);

    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);

    gl.viewport(0, 0, canvas.width, canvas.height);

    if(typeof Picker !== 'undefined' && Picker.fbo){
      Picker.resize(canvas.width, canvas.height);
    }
  }

  /* ======================================================================
   * 相机
   * ====================================================================== */
  function cameraEye(){
    const cp = Math.cos(state.pitch);
    return vec3(
      state.target[0] + state.dist * cp * Math.sin(state.yaw),
      state.target[1] + state.dist * Math.sin(state.pitch),
      state.target[2] + state.dist * cp * Math.cos(state.yaw)
    );
  }

  /* ======================================================================
   * 每帧
   * ====================================================================== */
  function frame(now){
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    render(dt);

    /* FPS */
    fpsAcc += dt; fpsFrames++;
    if(fpsAcc >= 0.4){
      const el = document.getElementById('stats');
      if(el){
        el.textContent = Math.round(fpsFrames / fpsAcc) + ' fps';
      }
      const dbg = document.getElementById('dbgInfo');
      if(dbg){
        dbg.textContent = '光栅化三角形 ' + countTriangles().toLocaleString()
                        + ' · 阴影图 ' + state.shadowMapSize + '²'
                        + ' · ' + (state.useBlinn ? 'Blinn-Phong' : 'Phong');
      }
      fpsAcc = 0; fpsFrames = 0;
    }

    requestAnimationFrame(frame);
  }

  function countTriangles(){
    let n = 0;
    state.objects.forEach(function(o){
      const g = vaoMap[o.geo];
      if(g) n += g.count / 3;
    });
    return Math.round(n);
  }

  function render(dt){
    /* ---------- 相机矩阵 ---------- */
    const eye = cameraEye();
    const at = vec3(state.target[0], state.target[1], state.target[2]);
    viewMat = lookAt(eye, at, vec3(0, 1, 0));

    const aspect = canvas.width / Math.max(canvas.height, 1);
    /* 注意：MV.js 的 perspective 内部已调 radians，这里传角度 */
    projMat = perspective(46, aspect, 0.1, 120);

    /* ---------- 光源相机 & 阴影 VP ---------- */
    const sceneCenter = vec3(0, 1.6, 0);
    Shadow.buildLightCamera(state.lights[0], sceneCenter, 7.6);
    lightVPForVS = Shadow.buildLightVPForVS(viewMat);

    /* ---------- ① 阴影深度第一遍 ---------- */
    if(state.shadowEnabled){
      Shadow.renderDepthPass(state.objects, vaoMap);
    }

    /* ---------- ② 主渲染 ---------- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.02, 0.025, 0.035, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    /* 天空盒：先画，不写深度 */
    gl.depthMask(false);
    drawSky();
    gl.depthMask(true);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    /* ---------- ③ 不透明物体 ---------- */
    gl.disable(gl.BLEND);
    state.objects.forEach(function(obj){
      if(obj.mat.alpha < 1) return;          // 透明的留到后面
      drawObject(obj);
    });

    /* ---------- ④ 透明物体（从远到近）---------- */
    const transparent = state.objects.filter(function(o){ return o.mat.alpha < 1; });
    if(transparent.length){
      transparent.sort(function(a, b){
        return distToEye(b) - distToEye(a);
      });
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);                   // 透明物体不写深度
      transparent.forEach(function(obj){ drawObject(obj); });
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    /* ---------- ⑤ 选中描边 ---------- */
    if(state.selectedId){
      const sel = state.objects.find(function(o){ return o.id === state.selectedId; });
      if(sel) drawOutline(sel);
    }
  }

  function distToEye(obj){
    const e = cameraEye();
    const dx = obj.pos[0] - e[0];
    const dy = obj.pos[1] - e[1];
    const dz = obj.pos[2] - e[2];
    return dx*dx + dy*dy + dz*dz;
  }

  /* ======================================================================
   * 绘制单个物体
   * ====================================================================== */
  function drawObject(obj){
    const g = vaoMap[obj.geo];
    if(!g) return;

    const m = obj.mat;
    const model = modelMatrix(obj);
    const mv = mult(viewMat, model);

    gl.useProgram(programMain.program);

    GL.setMat4(programMain.uniform.uModelView, mv);
    GL.setMat4(programMain.uniform.uProjection, projMat);
    GL.setMat3(programMain.uniform.uNormalMatrix, normalMatrix(mv));

    /* --- 材质 uniform --- */
    GL.setVec3(programMain.uniform.uKa, [m.ambient, m.ambient, m.ambient]);
    GL.setVec3(programMain.uniform.uKd, m.diffuse);
    GL.setVec3(programMain.uniform.uKs, [m.specular, m.specular, m.specular]);
    gl.uniform1f(programMain.uniform.uShininess, Math.max(1, m.shininess));
    gl.uniform1f(programMain.uniform.uReflect, m.reflect);
    gl.uniform1f(programMain.uniform.uAlpha, m.alpha);
    gl.uniform1f(programMain.uniform.uToon, m.toon ? 1 : 0);

    /* --- 三分量开关 --- */
    gl.uniform1f(programMain.uniform.uUseAmbient,  state.useAmbient  ? 1 : 0);
    gl.uniform1f(programMain.uniform.uUseDiffuse,  state.useDiffuse  ? 1 : 0);
    gl.uniform1f(programMain.uniform.uUseSpecular, state.useSpecular ? 1 : 0);

    /* --- 环境 --- */
    GL.setVec3(programMain.uniform.uEyePosVS, [0, 0, 0]);
    GL.setVec3(programMain.uniform.uGlobalAmbient,
               [state.globalAmbient, state.globalAmbient, state.globalAmbient]);

    /* --- 光源：转成视图空间 --- */
    uploadLights(viewMat);

    /* --- 纹理 --- */
    const tex = m.texKey ? textures[m.texKey] : null;
    gl.uniform1f(programMain.uniform.uHasTex, tex ? 1 : 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tex || GL.makePlaceholderTexture());
    gl.uniform1i(programMain.uniform.uTex, 1);
    /* UV 平铺：地板/桌面这类大平面靠它把木纹重复几遍 */
    const us = m.uvScale || [1, 1];
    gl.uniform2f(programMain.uniform.uUVScale, us[0], us[1]);

    const nmap = m.normalKey ? textures[m.normalKey] : null;
    gl.uniform1f(programMain.uniform.uHasNormalMap, nmap ? 1 : 0);
    gl.uniform1f(programMain.uniform.uNormalStrength, m.normalStrength);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, nmap || GL.makePlaceholderTexture());
    gl.uniform1i(programMain.uniform.uNormalMap, 2);

    /* --- 环境贴图 --- */
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, envMap);
    gl.uniform1i(programMain.uniform.uEnvMap, 3);
    gl.uniform1f(programMain.uniform.uEnvMode, m.reflect > 0.001 ? 1 : 0);

    /* --- 阴影 --- */
    gl.uniform1f(programMain.uniform.uShadowEnabled,
                 (state.shadowEnabled && obj.receiveShadow) ? 1 : 0);
    GL.setMat4(programMain.uniform.uLightVP, lightVPForVS);
    gl.uniform1f(programMain.uniform.uShadowTexel, 1.0 / state.shadowMapSize);
    gl.uniform1f(programMain.uniform.uShadowBias, state.lights[0].shadow.bias);
    gl.uniform1f(programMain.uniform.uPCF, state.lights[0].shadow.pcf ? 1 : 0);
    gl.uniform1f(programMain.uniform.uShadowAmbient, 0.20);

    Shadow.bindDepthTexture(4, programMain.uniform.uShadowMap);

    gl.bindVertexArray(g.vao);
    gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  /* 把光源参数从世界空间变换到视图空间 */
  function uploadLights(vm){
    const lights = state.lights;
    gl.uniform1i(programMain.uniform.uNumLights, lights.length);

    const types = [], posVS = [], dirVS = [], colors = [], atten = [];
    /* 视图矩阵的旋转部分（3×3）用于变换方向 */
    const R = [
      [vm[0][0], vm[0][1], vm[0][2]],
      [vm[1][0], vm[1][1], vm[1][2]],
      [vm[2][0], vm[2][1], vm[2][2]]
    ];

    lights.forEach(function(L){
      types.push(L.type);
      const c = [
        L.color[0] * L.intensity,
        L.color[1] * L.intensity,
        L.color[2] * L.intensity
      ];
      colors.push(c);

      if(L.type === 0){
        /* 方向光：方向向量只用旋转部分变换 */
        const d = L.direction;
        let dx = R[0][0]*d[0] + R[0][1]*d[1] + R[0][2]*d[2];
        let dy = R[1][0]*d[0] + R[1][1]*d[1] + R[1][2]*d[2];
        let dz = R[2][0]*d[0] + R[2][1]*d[1] + R[2][2]*d[2];
        const l = Math.hypot(dx, dy, dz) || 1;
        dirVS.push([dx/l, dy/l, dz/l]);
        posVS.push([0, 0, 0]);
        atten.push([1, 0, 0]);
      } else {
        /* 点光：位置要完整变换（含平移） */
        const p = L.position;
        const x = vm[0][0]*p[0] + vm[0][1]*p[1] + vm[0][2]*p[2] + vm[0][3];
        const y = vm[1][0]*p[0] + vm[1][1]*p[1] + vm[1][2]*p[2] + vm[1][3];
        const z = vm[2][0]*p[0] + vm[2][1]*p[1] + vm[2][2]*p[2] + vm[2][3];
        posVS.push([x, y, z]);
        dirVS.push([0, -1, 0]);
        atten.push(L.attenuation);
      }
    });

    GL.setIntArray(programMain.uniform.uLightType, types);
    GL.setVec3a(programMain.uniform.uLightPosVS, posVS);
    GL.setVec3a(programMain.uniform.uLightDirVS, dirVS);
    GL.setVec3a(programMain.uniform.uLightColor, colors);
    GL.setVec3a(programMain.uniform.uLightAtten, atten);
  }

  /* ======================================================================
   * 天空盒
   * ----------------------------------------------------------------------
   * 视图矩阵去掉平移（只留旋转），这样天空盒永远包住相机、不会穿帮。
   * ====================================================================== */
  function drawSky(){
    gl.useProgram(programSky.program);
    gl.disable(gl.CULL_FACE);

    /* 用 mat4() 建单位矩阵再逐元素填旋转部分。
       不能直接写二维数组字面量——MV.js 的 mult 靠 .type 判断类型，
       裸数组没有 .type 会抛 "trying to mult incompatible types"。 */
    const rotOnly = mat4();
    for(let i = 0; i < 3; i++){
      for(let j = 0; j < 3; j++){
        rotOnly[i][j] = viewMat[i][j];
      }
    }

    const s = scale(60, 60, 60);
    GL.setMat4(programSky.uniform.uViewRotOnly, mult(rotOnly, s));
    GL.setMat4(programSky.uniform.uProjection, projMat);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, envMap);
    gl.uniform1i(programSky.uniform.uEnvMap, 3);

    gl.bindVertexArray(skyVAO.vao);
    gl.drawElements(gl.TRIANGLES, skyVAO.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);
  }

  /* ======================================================================
   * 选中描边
   * ----------------------------------------------------------------------
   * 放大壳 + 只画背面：壳的背面正好落在物体轮廓外侧，
   * 形成一个粗细均匀的描边。
   * ====================================================================== */
  function drawOutline(obj){
    const g = vaoMap[obj.geo];
    if(!g) return;

    gl.useProgram(programOutline.program);
    GL.setMat4(programOutline.uniform.uProjection, projMat);

    const model = modelMatrix(obj);
    const mv = mult(viewMat, model);
    GL.setMat4(programOutline.uniform.uModelView, mv);
    GL.setMat3(programOutline.uniform.uNormalMatrix, normalMatrix(mv));

    /* 描边在视图空间外扩，值要随物体尺寸调 */
    const avgScale = (obj.scale[0] + obj.scale[1] + obj.scale[2]) / 3;
    gl.uniform1f(programOutline.uniform.uOutlineWidth, 0.045 * avgScale);
    gl.uniform4f(programOutline.uniform.uColor, 1.0, 0.78, 0.25, 1.0);

    /* 只画背面，并且不写深度（否则会挡住物体本体） */
    gl.cullFace(gl.FRONT);
    gl.depthMask(false);

    gl.bindVertexArray(g.vao);
    gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    gl.depthMask(true);
    gl.cullFace(gl.BACK);
  }

  /* ======================================================================
   * 交互
   * ====================================================================== */
  function bindEvents(){
    let dragging = false;
    let lastX = 0, lastY = 0;
    let moved = 0;

    canvas.addEventListener('pointerdown', function(e){
      dragging = true;
      moved = 0;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', function(e){
      if(!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      moved += Math.abs(dx) + Math.abs(dy);

      state.yaw   -= dx * 0.006;
      state.pitch += dy * 0.006;
      /* 限制俯仰，避免翻到地板下面 */
      state.pitch = Math.max(-0.15, Math.min(1.35, state.pitch));
    });

    canvas.addEventListener('pointerup', function(e){
      dragging = false;
      canvas.style.cursor = 'default';
      canvas.releasePointerCapture(e.pointerId);

      /* 位移很小才算「点击」，避免拖拽视角时误触发拾取 */
      if(moved < 5){
        handleClick(e);
      }
    });

    canvas.addEventListener('wheel', function(e){
      e.preventDefault();
      state.dist *= Math.exp(e.deltaY * 0.0011);
      state.dist = Math.max(6, Math.min(48, state.dist));
    }, { passive: false });

    window.addEventListener('resize', resize);

    /* 键盘 */
    window.addEventListener('keydown', function(e){
      if(e.key === '1'){ setPreset([1,0,0]); }
      if(e.key === '2'){ setPreset([0,1,0]); }
      if(e.key === '3'){ setPreset([0,0,1]); }
      if(e.key === '4'){ setPreset([1,1,1]); }
      if(e.key === 'Escape'){ selectObject(0); }
      if(e.key === 'h' || e.key === 'H'){ togglePanel(); }
    });
  }

  function setPreset(v){
    state.useAmbient  = !!v[0];
    state.useDiffuse  = !!v[1];
    state.useSpecular = !!v[2];
    UI.rebuild();
  }

  function togglePanel(){
    const p = document.getElementById('panel');
    p.classList.toggle('hidden');
    resize();
  }

  function handleClick(e){
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const hit = Picker.pick(state.objects, vaoMap, viewMat, projMat,
                            x, y, canvas.width, canvas.height, dpr);

    selectObject(hit);
  }

  function selectObject(id){
    state.selectedId = id;
    UI.rebuildMeshParams();

    const el = document.getElementById('selName');
    if(el){
      const obj = id ? state.objects.find(function(o){ return o.id === id; }) : null;
      el.textContent = obj ? obj.name : '（未选中）';
    }
    if(canvas) canvas.style.cursor = id ? 'pointer' : 'default';
  }

  return {
    init: init,
    get state(){ return state; },
    selectObject: selectObject,
    render: render,
    /* 调试/测试用：暴露内部矩阵与几何表，
       便于在控制台查看当前相机、验证阴影对齐，也供自动化测试探针读取。 */
    debug: {
      get view(){ return viewMat; },
      get proj(){ return projMat; },
      get lightVPForVS(){ return lightVPForVS; },
      get vaoMap(){ return vaoMap; },
      get textures(){ return textures; },
      get programMain(){ return programMain; },
      get dpr(){ return dpr; }
    }
  };
})();

/* 启动 */
window.addEventListener('DOMContentLoaded', function(){
  try {
    App.init();
  } catch(err){
    const box = document.getElementById('err');
    const msg = document.getElementById('errMsg');
    if(box && msg){
      msg.textContent = err.message + '\n\n' + (err.stack || '');
      box.style.display = 'grid';
    } else {
      alert(err.message);
    }
    console.error(err);
  }
});
