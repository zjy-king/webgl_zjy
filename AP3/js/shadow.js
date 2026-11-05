/* ==========================================================================
 * shadow.js  ——  阴影贴图（两遍渲染）
 * --------------------------------------------------------------------------
 * 教材 Ch8.8 阴影贴图原理，两遍渲染：
 *
 *  【第一遍】从光源位置看场景，只读深度，存进一张纹理
 *      · 光源视角用正交投影（方向光）或透视投影（点光）
 *      · 把每个片元「离光源最近的那个深度」记录到 depthMap[u][v]
 *      · 这一遍不需要颜色，所以 FBO 只挂深度附件
 *
 *  【第二遍】从相机位置正常渲染，对每个片元做「深度比较」
 *      · 把该片元用同一个 lightVP 变换到光源的裁剪空间，得到它的光源深度 z
 *      · 拿 (u,v) 去 depthMap 查出该方向上「最近遮挡物」的深度 d
 *      · 若 z > d + bias，说明这个片元被别的东西挡在光源前面 → 处于阴影中
 *
 *  【两条必须说清楚的技术细节】
 *
 *  1) 两个变换空间必须一致。
 *     主着色器里 vPosVS 是【视图空间】坐标，而 lightVP 是
 *     「光源投影 × 光源视图 × 模型」，作用在【世界空间】顶点上。
 *     所以传给 shader 的 uLightVP 要写成
 *        lightVP_view = lightProj * lightView * inverse(view)
 *     这样 lightVP_view * vPosVS 就等价于 lightVP_world * 世界坐标。
 *     本项目采用这个做法，见 buildLightVPForVS()。
 *
 *  2) bias 不可省。
 *     深度纹理的分辨率有限，一个纹素覆盖一片表面，
 *     斜射时同一纹素的深度差异会超过精度，产生自遮挡条纹（shadow acne）。
 *     bias 太小 → 条纹；太大 → 阴影与物体脱离（peter-panning，漏光）。
 *     面板里给滑块就是为了直观看到这个权衡。
 * ========================================================================== */
'use strict';

const Shadow = (function(){

  let gl = null;
  let shadowFBO = null;
  let depthProgram = null;

  /* 光源视角矩阵（世界空间），每帧重建 */
  let lightView = null;
  let lightProj = null;
  let lightVPWorld = null;

  /* 初始化 */
  function init(glCtx){
    gl = glCtx;

    /* 深度着色器：只需要 aPosition 一个属性 */
    depthProgram = GL.buildProgram(SHADERS.depthVS, SHADERS.depthFS,
                                   ['uLightVP', 'uModel']);

    shadowFBO = GL.createShadowFBO(1024);
    return shadowFBO;
  }

  /* 光源分辨率变化时重建 FBO（面板可调，用于观察锯齿） */
  function setMapSize(size){
    if(shadowFBO && shadowFBO.size === size) return shadowFBO;
    if(shadowFBO && shadowFBO.fbo) gl.deleteFramebuffer(shadowFBO.fbo);
    if(shadowFBO && shadowFBO.tex) gl.deleteTexture(shadowFBO.tex);
    shadowFBO = GL.createShadowFBO(size);
    return shadowFBO;
  }

  /* ======================================================================
   * 构造光源视角矩阵
   * ----------------------------------------------------------------------
   * 方向光用正交投影：因为没有位置，视锥是一个平行长方体。
   *   left/right/bottom/top 决定阴影覆盖的世界范围——
   *   范围越小分辨率越高，阴影越清晰；但要能罩住所有投影物体。
   *
   * 光源位置取「场景中心 - 方向 × 距离」，这样相机摆在场景外往回看。
   * ====================================================================== */
  function buildLightCamera(light, sceneCenter, sceneRadius){
    const dir = normalize(vec3(light.direction[0], light.direction[1], light.direction[2]));

    /* 光源摆在场景外围：中心沿光线反方向退出去。
       距离只需「刚好把整个场景球装进来」——退得太远会让 near/far 跨度变大，
       深度精度被摊薄，阴影边缘抖动、bias 需要调到很大才能压住 acne。
       取半径的 1.25 倍即可（场景球半径 + 余量）。 */
    const dist = sceneRadius * 1.25;
    const eye = vec3(
      sceneCenter[0] - dir[0] * dist,
      sceneCenter[1] - dir[1] * dist,
      sceneCenter[2] - dir[2] * dist
    );

    lightView = lookAt(eye, sceneCenter, vec3(0, 1, 0));

    const s = light.shadow;
    /* near/far 跟着相机距离自适应：近平面压在场景球前缘外侧一点点，
       远平面放到后缘之外。这样深度缓冲的有效动态范围几乎全部落在场景上。 */
    const nearPlane = Math.max(0.1, dist - sceneRadius * 1.05);
    const farPlane  = dist + sceneRadius * 1.05;

    lightProj = ortho(s.left, s.right, s.bottom, s.top, nearPlane, farPlane);
    lightVPWorld = mult(lightProj, lightView);
    return lightVPWorld;
  }

  /* ======================================================================
   * 把「作用于世界空间」的 lightVP 转成「作用于视图空间」
   * ----------------------------------------------------------------------
   * 主着色器拿到的是 vPosVS（视图空间），直接乘 lightVPWorld 会错位，
   * 表现为阴影整体偏移、旋转。
   *
   * 推导：要让  lightVP_view · pView  ==  lightVP_world · pWorld
   *       又因为        pView = view · pWorld
   *       所以  lightVP_view · view · pWorld = lightVP_world · pWorld
   *       ⇒    lightVP_view = lightVP_world · view⁻¹
   *
   * 这一步是阴影能否对齐的关键，很多实现出错都在这里。
   * ====================================================================== */
  function buildLightVPForVS(viewMat){
    const invView = inverse(viewMat);
    return mult(lightVPWorld, invView);
  }

  /* ======================================================================
   * 第一遍：渲染深度到 FBO
   * ----------------------------------------------------------------------
   * @param objects  场景物体列表
   * @param vaoMap   几何体 key → { vao, count }
   * ====================================================================== */
  function renderDepthPass(objects, vaoMap){
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFBO.fbo);
    gl.viewport(0, 0, shadowFBO.size, shadowFBO.size);

    /* 深度测试开、写深度开；关颜色写入（FBO 本来就没有颜色附件）*/
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    /* 投影阴影时不能剔背面吗？
       默认剔背面会让「正面朝向光源、背面背光」的薄物体（如平面）在
       深度图里留下的是背面深度，导致 acne 减轻但 peter-panning 加重。
       这里改用剔除【正面】（cull front）：让深度图记录物体的背面，
       相当于把深度整体往后推了一点，是一种常见的抗 acne 技巧，
       效果等价于把 bias 的一部分做进几何里。 */
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);

    gl.useProgram(depthProgram.program);
    GL.setMat4(depthProgram.uniform.uLightVP, lightVPWorld);

    objects.forEach(function(obj){
      if(!obj.castShadow) return;
      const g = vaoMap[obj.geo];
      if(!g) return;

      const model = modelMatrix(obj);
      GL.setMat4(depthProgram.uniform.uModel, model);
      gl.bindVertexArray(g.vao);
      gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_INT, 0);
    });

    gl.bindVertexArray(null);
    gl.cullFace(gl.BACK);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /* 供主着色器绑定深度纹理用 */
  function bindDepthTexture(unit, locSampler){
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, shadowFBO.tex);
    gl.uniform1i(locSampler, unit);
  }

  return {
    init: init,
    setMapSize: setMapSize,
    buildLightCamera: buildLightCamera,
    buildLightVPForVS: buildLightVPForVS,
    renderDepthPass: renderDepthPass,
    bindDepthTexture: bindDepthTexture,
    get fbo(){ return shadowFBO; },
    get lightView(){ return lightView; },
    get lightProj(){ return lightProj; },
    get lightVPWorld(){ return lightVPWorld; }
  };
})();

/* ==========================================================================
 * 模型矩阵：平移 × 旋转(Z→Y→X) × 缩放
 * --------------------------------------------------------------------------
 * 注意变换顺序：作用到顶点时从右往左执行，
 * 即「先缩放 → 再旋转 → 最后平移」，这是直觉上的物体摆放方式。
 * ========================================================================== */
function modelMatrix(obj){
  const t = translate(obj.pos[0], obj.pos[1], obj.pos[2]);
  const rz = rotate(obj.rot[2], vec3(0, 0, 1));
  const ry = rotate(obj.rot[1], vec3(0, 1, 0));
  const rx = rotate(obj.rot[0], vec3(1, 0, 0));
  const sc = scale(obj.scale[0], obj.scale[1], obj.scale[2]);

  let m = mult(t, rz);
  m = mult(m, ry);
  m = mult(m, rx);
  m = mult(m, sc);
  return m;
}
