/* ==========================================================================
 * picking.js  ——  颜色编码拾取（教材 3.9 拾取思想）
 * --------------------------------------------------------------------------
 * 原理：
 *   1) 把每个可拾取物体渲染成「它自己的 ID 对应的纯色」到一个离屏 FBO，
 *      此时不计算光照、不采样纹理、不混合——片元颜色只由 ID 决定；
 *   2) 鼠标点击时把该像素 readPixels 读回来，反解出 ID。
 *
 * 为什么 ID 不错位：
 *   深度测试照常开启，所以同一像素上只有最靠前的物体能写入颜色，
 *   「点到谁」与「看到谁」完全一致。透明物体也参与（它的深度照写）。
 *
 * 为什么用 2×2 采样而不是 1×1：
 *   鼠标落在细物体边缘时，单像素可能采到背景。
 *   取 2×2 四个像素，谁不是背景就选谁，容错更好。
 *
 * ID → 颜色 编码：
 *   id = r + g·256 + b·65536，即把 24 位整数拆成三通道。
 *   1 个通道 8 位，最多支持 1600 万物体，本项目 15 个绰绰有余。
 * ========================================================================== */
'use strict';

const Picker = (function(){

  let gl = null;
  let pickFBO = null;
  let program = null;

  /* 缓存最近一次的拾取结果，避免同一帧重复渲染 */
  let lastPickFrame = -1;
  let lastPickResult = null;

  function init(glCtx, w, h){
    gl = glCtx;
    program = GL.buildProgram(SHADERS.pickVS, SHADERS.pickFS,
                              ['uModelView', 'uProjection', 'uPickColor']);
    pickFBO = GL.createColorFBO(w, h);
    return pickFBO;
  }

  function resize(w, h){
    GL.resizeColorFBO(pickFBO, w, h);
  }

  /* ID → RGB（归一化到 0~1） */
  function idToColor(id){
    const r = (id & 0xFF) / 255;
    const g = ((id >> 8) & 0xFF) / 255;
    const b = ((id >> 16) & 0xFF) / 255;
    return [r, g, b];
  }

  function colorToId(r, g, b){
    return r + (g << 8) + (b << 16);
  }

  /* ======================================================================
   * 渲染 ID 缓冲
   * ----------------------------------------------------------------------
   * @param objects  场景物体
   * @param vaoMap   几何体表
   * @param view     主相机的视图矩阵
   * @param proj     主相机的投影矩阵
   * ====================================================================== */
  function renderIDBuffer(objects, vaoMap, view, proj){
    gl.bindFramebuffer(gl.FRAMEBUFFER, pickFBO.fbo);
    gl.viewport(0, 0, pickFBO.w, pickFBO.h);

    /* 背景设为黑色 = ID 0，用于区分「没点到」 */
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);

    /* 关闭混合：拾取只关心「谁在最前面」，透明物体也要写自己的 ID */
    gl.disable(gl.BLEND);
    /* 关闭剔除：避免单面几何（地面）从背面点不到 */
    gl.disable(gl.CULL_FACE);

    gl.useProgram(program.program);
    GL.setMat4(program.uniform.uProjection, proj);

    objects.forEach(function(obj){
      if(!obj.pickable) return;
      const g = vaoMap[obj.geo];
      if(!g) return;

      const mv = mult(view, modelMatrix(obj));
      GL.setMat4(program.uniform.uModelView, mv);
      GL.setVec3(program.uniform.uPickColor, idToColor(obj.id));

      gl.bindVertexArray(g.vao);
      gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
    });

    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    /* 恢复默认状态，别污染主渲染 */
    gl.enable(gl.CULL_FACE);
    gl.clearColor(0.02, 0.025, 0.035, 1);
  }

  /* ======================================================================
   * 拾取：给定画布像素坐标，返回物体 id（0 = 没点到）
   * ----------------------------------------------------------------------
   * 注意 WebGL 的像素原点在【左下】，而 DOM 事件坐标原点在【左上】，
   * 所以 y 要翻转：glY = canvasHeight - domY（还要乘 dpr）。
   * ====================================================================== */
  function pick(objects, vaoMap, view, proj, domX, domY, canvasW, canvasH, dpr){
    renderIDBuffer(objects, vaoMap, view, proj);

    const px = Math.floor(domX * dpr);
    /* DOM 左上原点 → GL 左下原点 */
    const py = Math.floor(canvasH - domY * dpr);

    /* 先精确读中心 1 个像素 —— 这一枪打中就用它，最准。
       只有中心落在背景（ID=0）时才去试周围 3×3，
       用于细长物体边缘的容错。
       注意不能一上来就读 2×2 再「取第一个非零」：
       readPixels 的起点是左下角，2×2 区域里第 3、4 个像素是右上方，
       顺序并不等于「由近到远」，细物体边缘很容易被邻像素的桌面抢走。 */
    const centerBuf = new Uint8Array(4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, pickFBO.fbo);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    const cx = Math.max(0, Math.min(pickFBO.w - 1, px));
    const cy = Math.max(0, Math.min(pickFBO.h - 1, py));
    gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, centerBuf);

    let hit = centerBuf[0] + (centerBuf[1] << 8) + (centerBuf[2] << 16);

    if(hit === 0){
      /* 容错：3×3 邻域，取离中心最近的非零像素 */
      const x0 = Math.max(0, Math.min(pickFBO.w - 3, px - 1));
      const y0 = Math.max(0, Math.min(pickFBO.h - 3, py - 1));
      const buf = new Uint8Array(4 * 9);
      gl.readPixels(x0, y0, 3, 3, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let bestD = 99;
      for(let j = 0; j < 3; j++){
        for(let i2 = 0; i2 < 3; i2++){
          const k = (j * 3 + i2) * 4;
          const id = buf[k] + (buf[k+1] << 8) + (buf[k+2] << 16);
          if(!id) continue;
          const d = Math.abs((x0 + i2) - px) + Math.abs((y0 + j) - py);
          if(d < bestD){ bestD = d; hit = id; }
        }
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    lastPickResult = hit;
    return hit;
  }

  return {
    init: init,
    resize: resize,
    renderIDBuffer: renderIDBuffer,
    pick: pick,
    idToColor: idToColor,
    colorToId: colorToId,
    get fbo(){ return pickFBO; }
  };
})();
