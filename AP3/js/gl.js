/* ==========================================================================
 * gl.js  ——  WebGL 底层封装
 * --------------------------------------------------------------------------
 * 职责：上下文创建、程序编译、VAO 上传、纹理/立方体贴图、FBO。
 * 不包含任何场景逻辑，被 main.js / shadow.js / picking.js 调用。
 * ========================================================================== */
'use strict';

const GL = (function(){

  let gl = null;

  /* ======================================================================
   * 上下文
   * ====================================================================== */
  function init(canvas){
    gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true   // 截图与 readPixels 需要
    });
    if(!gl){
      throw new Error('无法创建 WebGL2 上下文。请用新版 Chrome/Edge，并确认 chrome://gpu 中硬件加速已开启。');
    }
    return gl;
  }

  /* ======================================================================
   * 程序与 uniform 位置缓存
   * ----------------------------------------------------------------------
   * getUniformLocation 是字符串查表，每帧每物体调用会明显掉帧，
   * 因此初始化时一次性把位置全部取出来存进对象。
   * ====================================================================== */
  function buildProgram(vsSrc, fsSrc, uniformNames){
    const prog = createProgram(gl, vsSrc, fsSrc);   // 教材 utility.js 提供

    const info = {
      program: prog,
      attrib: {},
      uniform: {}
    };

    /* 属性位置：自动扫描常见命名 */
    const attrNames = ['aPosition', 'aNormal', 'aTexCoord', 'aTangent'];
    attrNames.forEach(function(n){
      const loc = gl.getAttribLocation(prog, n);
      if(loc >= 0) info.attrib[n] = loc;
    });

    (uniformNames || []).forEach(function(n){
      info.uniform[n] = gl.getUniformLocation(prog, n);
    });

    return info;
  }

  /* ======================================================================
   * 几何体 → VAO
   * ----------------------------------------------------------------------
   * 传入 { pos, nrm, uv, idx }，返回 { vao, count }。
   *
   * 注意 ELEMENT_ARRAY_BUFFER 的绑定属于 VAO 状态，
   * 而 ARRAY_BUFFER 的绑定不属于——所以索引要在 VAO 内绑一次即可，
   * 但顶点属性的 vertexAttribPointer 也要在 VAO 内设置。
   * ====================================================================== */
  function uploadGeometry(geo, attribLocs){
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    /* --- 位置 --- */
    if(attribLocs.aPosition !== undefined){
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, geo.pos, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(attribLocs.aPosition);
      gl.vertexAttribPointer(attribLocs.aPosition, 3, gl.FLOAT, false, 0, 0);
    }

    /* --- 法线 --- */
    if(attribLocs.aNormal !== undefined && geo.nrm){
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, geo.nrm, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(attribLocs.aNormal);
      gl.vertexAttribPointer(attribLocs.aNormal, 3, gl.FLOAT, false, 0, 0);
    }

    /* --- UV --- */
    if(attribLocs.aTexCoord !== undefined && geo.uv){
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, geo.uv, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(attribLocs.aTexCoord);
      gl.vertexAttribPointer(attribLocs.aTexCoord, 2, gl.FLOAT, false, 0, 0);
    }

    /* --- 切线（法线贴图用）---
       由位置和法线解析求：取一个与法线不平行的参考轴，
       叉乘得到切线。对球面/柱面/圆环的 UV 布局来说，
       这样得到的切线与 u 方向足够接近。 */
    if(attribLocs.aTangent !== undefined && geo.nrm){
      const t = new Float32Array(geo.nrm.length);
      for(let i = 0; i < geo.nrm.length; i += 3){
        const nx = geo.nrm[i], ny = geo.nrm[i+1], nz = geo.nrm[i+2];
        /* 选与法线最不平行的主轴作为参考 */
        let ax = 0, ay = 0, az = 0;
        if(Math.abs(ny) < 0.9){ ay = 1; } else { ax = 1; }
        /* T = normalize(ref × N) */
        let tx = ay * nz - az * ny;
        let ty = az * nx - ax * nz;
        let tz = ax * ny - ay * nx;
        const l = Math.hypot(tx, ty, tz) || 1;
        t[i] = tx / l; t[i+1] = ty / l; t[i+2] = tz / l;
      }
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, t, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(attribLocs.aTangent);
      gl.vertexAttribPointer(attribLocs.aTangent, 3, gl.FLOAT, false, 0, 0);
    }

    /* --- 索引 --- */
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.idx, gl.STATIC_DRAW);

    gl.bindVertexArray(null);
    return { vao: vao, count: geo.idx.length };
  }

  /* ======================================================================
   * 2D 纹理
   * ----------------------------------------------------------------------
   * UNPACK_FLIP_Y_WEBGL 必需：图片原点在左上（y 向下），
   * 而纹理坐标原点在左下（v 向上），不翻转会让贴图上下颠倒。
   * 它是【全局像素存储状态】，用完必须复位，否则污染后续所有上传。
   * ====================================================================== */
  const texCache = {};

  function makePlaceholderTexture(rgb){
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const c = rgb || [170, 170, 175];
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                  new Uint8Array([c[0], c[1], c[2], 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  function loadTexture(url, onDone){
    if(texCache[url] && texCache[url].ready){
      if(onDone) onDone(texCache[url].tex);
      return texCache[url].tex;
    }

    /* 先返回占位纹理，图片到了再替换——避免首帧黑屏 */
    let entry = texCache[url];
    if(!entry){
      entry = texCache[url] = { tex: makePlaceholderTexture(), ready: false };
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = function(){
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

      entry.tex = t;
      entry.ready = true;
      TEX_STATUS.ok++;
      if(onDone) onDone(t);
      refreshTexStatus();
    };
    img.onerror = function(){
      TEX_STATUS.failed.push(url);
      console.warn('[纹理] 加载失败：' + url);
      refreshTexStatus();
    };
    img.src = url;
    TEX_STATUS.need++;
    return entry.tex;
  }

  const TEX_STATUS = { ok: 0, need: 0, failed: [] };

  function refreshTexStatus(){
    const el = document.getElementById('texStatus');
    if(!el) return;
    const miss = TEX_STATUS.need - TEX_STATUS.ok;
    el.textContent = miss <= 0
      ? '✓ 纹理 ' + TEX_STATUS.ok + '/' + TEX_STATUS.need + ' 已加载'
      : '纹理 ' + TEX_STATUS.ok + '/' + TEX_STATUS.need + '（缺 ' + miss + '）';
    el.style.color = miss <= 0 ? '#7ec699' : '#e8a05a';
  }

  /* ======================================================================
   * 立方体贴图（cubemap）
   * ----------------------------------------------------------------------
   * 6 张图分别对应 +X,−X,+Y,−Y,+Z,−Z 六个面。
   * WebGL2 支持直接从 canvas / Image 上传到 CUBE_MAP 的某个面。
   *
   * 这里没有用真实照片，而是用 2D canvas 程序化画出「房间 + 天光」的
   * 六个面——好处是零版权风险、体积小，而且反射出来的图案能看出朝向。
   * ====================================================================== */
  const CUBE_FACES = [
    'px', 'nx', 'py', 'ny', 'pz', 'nz'
  ];
  const CUBE_TARGETS = [
    'TEXTURE_CUBE_MAP_POSITIVE_X',
    'TEXTURE_CUBE_MAP_NEGATIVE_X',
    'TEXTURE_CUBE_MAP_POSITIVE_Y',
    'TEXTURE_CUBE_MAP_NEGATIVE_Y',
    'TEXTURE_CUBE_MAP_POSITIVE_Z',
    'TEXTURE_CUBE_MAP_NEGATIVE_Z'
  ];

  function loadCubemap(urls, onDone){
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);

    /* 占位：1×1 灰色充填 6 个面，保证采样不返回黑 */
    for(let i = 0; i < 6; i++){
      gl.texImage2D(gl[ CUBE_TARGETS[i] ], 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                    new Uint8Array([60, 64, 72, 255]));
    }

    let loaded = 0;
    urls.forEach(function(url, i){
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function(){
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
        /* 立方体面在语义上是「从内部往外看」，图片本身不留翻转，
           直接按行序上传即可。 */
        gl.texImage2D(gl[ CUBE_TARGETS[i] ], 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        loaded++;
        if(loaded === 6){
          gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
          gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
          gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
          if(onDone) onDone(tex);
        }
      };
      img.onerror = function(){
        console.warn('[立方体贴图] 加载失败：' + url);
        loaded++;
        if(loaded === 6 && onDone) onDone(tex);
      };
      img.src = url;
    });

    return tex;
  }

  /* ======================================================================
   * 帧缓冲对象（FBO）
   * ====================================================================== */

  /* 阴影贴图：只挂深度附件，颜色附件关掉。
     用 DEPTH_COMPONENT32F 而不是 24 位，减少深度精度导致的 acne（阴影痤疮）。
     配置 sampler2DShadow 后可以走硬件 PCF 比较。 */
  function createShadowFBO(size){
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

    const depthTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, depthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, size, size, 0,
                  gl.DEPTH_COMPONENT, gl.FLOAT, null);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    /* 关键：开启比较模式，shader 里才能用 sampler2DShadow 走硬件 PCF */
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
                            gl.TEXTURE_2D, depthTex, 0);

    /* 只用深度，必须显式声明不读颜色 */
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if(status !== gl.FRAMEBUFFER_COMPLETE){
      console.error('阴影 FBO 不完整，状态码 = 0x' + status.toString(16));
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo: fbo, tex: depthTex, size: size };
  }

  /* 离屏颜色缓冲：用于拾取（渲染 ID 颜色）和描边 */
  function createColorFBO(w, h){
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

    const colorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
                            gl.TEXTURE_2D, colorTex, 0);

    /* 拾取需要深度测试，否则后面的物体会盖住前面的 */
    const depthBuf = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthBuf);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
                               gl.RENDERBUFFER, depthBuf);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if(status !== gl.FRAMEBUFFER_COMPLETE){
      console.error('拾取 FBO 不完整，状态码 = 0x' + status.toString(16));
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo: fbo, tex: colorTex, w: w, h: h };
  }

  function resizeColorFBO(target, w, h){
    if(target.w === w && target.h === h) return;
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    target.w = w; target.h = h;
  }

  /* ======================================================================
   * 工具
   * ====================================================================== */

  /* 矩阵上传。必须用 MV.js 的 flatten()——它内部会做转置
     （MV.js 行主序存储 vs GLSL 列主序）。自己手写铺平会让矩阵转置。 */
  function setMat4(loc, m){
    if(loc === null || loc === undefined) return;
    gl.uniformMatrix4fv(loc, false, flatten(m));
  }

  function setMat3(loc, m){
    if(loc === null || loc === undefined) return;
    gl.uniformMatrix3fv(loc, false, flatten(m));
  }

  function setVec3(loc, v){
    if(loc === null || loc === undefined) return;
    gl.uniform3f(loc, v[0], v[1], v[2]);
  }

  function setVec3a(loc, arr){
    if(loc === null || loc === undefined) return;
    /* 把 [[r,g,b],[r,g,b]] 展平成一维传给 uniform3fv */
    const flat = new Float32Array(arr.length * 3);
    for(let i = 0; i < arr.length; i++){
      flat[i*3]   = arr[i][0];
      flat[i*3+1] = arr[i][1];
      flat[i*3+2] = arr[i][2];
    }
    gl.uniform3fv(loc, flat);
  }

  function setIntArray(loc, arr){
    if(loc === null || loc === undefined) return;
    gl.uniform1iv(loc, new Int32Array(arr));
  }

  /* 从法线矩阵 */
  function normalMat4(mv){
    return normalMatrix(mv);
  }

  return {
    init: init,
    get gl(){ return gl; },
    buildProgram: buildProgram,
    uploadGeometry: uploadGeometry,
    loadTexture: loadTexture,
    loadCubemap: loadCubemap,
    makePlaceholderTexture: makePlaceholderTexture,
    createShadowFBO: createShadowFBO,
    createColorFBO: createColorFBO,
    resizeColorFBO: resizeColorFBO,
    setMat4: setMat4,
    setMat3: setMat3,
    setVec3: setVec3,
    setVec3a: setVec3a,
    setIntArray: setIntArray,
    CUBE_TARGETS: CUBE_TARGETS,
    TEX_STATUS: TEX_STATUS,
    refreshTexStatus: refreshTexStatus
  };
})();
