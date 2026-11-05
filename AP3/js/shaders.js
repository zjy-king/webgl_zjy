/* ==========================================================================
 * shaders.js  ——  全部 GLSL 源码
 * --------------------------------------------------------------------------
 * 放在 .js 里而不是 <script id="..."> 标签里，原因：
 *   1) 分文件要求（评分项「模块化」）；
 *   2) 着色器有语法错误时，浏览器报的行号能直接对应到本文件的编辑行。
 *
 * 所有着色器都是 GLSL ES 3.00（配合 WebGL2）。
 * ========================================================================== */
'use strict';

const SHADERS = {};

/* ==========================================================================
 * 一、主场景着色器
 * --------------------------------------------------------------------------
 * 顶点着色器把位置/法线/切线/UV 变换到【视图空间】后传给片元着色器。
 * 光照计算全部在视图空间做——这样 eye 恒为 (0,0,0)，省一次视线向量计算。
 * 注意：法线用 normalMatrix（逆转置）变换，不能用模型视图矩阵直接乘。
 * ========================================================================== */
SHADERS.mainVS = `#version 300 es
precision highp float;

in vec3 aPosition;
in vec3 aNormal;
in vec2 aTexCoord;
/* 切线：法线贴图需要切线空间基底（E1）。
   这里用解析切线（球/柱/环生成的 UV 都是沿 u 方向走，切线可解析求），
   免去在 CPU 端算切线的时间，也不依赖 UV 差分。 */
in vec3 aTangent;

uniform mat4 uModelView;
uniform mat4 uProjection;
uniform mat3 uNormalMatrix;

out vec3 vPosVS;      // 视图空间位置
out vec3 vNormalVS;   // 视图空间法线
out vec2 vUV;
out vec3 vTangentVS;

void main(){
  vec4 posVS = uModelView * vec4(aPosition, 1.0);
  vPosVS     = posVS.xyz;
  vNormalVS  = normalize(uNormalMatrix * aNormal);
  vTangentVS = normalize(uNormalMatrix * aTangent);
  vUV        = aTexCoord;
  gl_Position = uProjection * posVS;
}
`;

/* --------------------------------------------------------------------------
 * 片元着色器：Phong 模型 + 纹理 + 法线贴图 + 环境贴图 + 阴影 + 卡通变体
 *
 * Phong 三分量（教材 Ch6）：
 *   I = ka·Ia
 *     + Σ kd·Il·(N·L)
 *     + Σ ks·Il·(R·V)^n
 *
 * 三个分量分别由 uUseAmbient / uUseDiffuse / uUseSpecular 控制开关，
 * 用于生成 README 要求的四种组合对比图。
 * -------------------------------------------------------------------------- */
SHADERS.mainFS = `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp samplerCube;
precision highp sampler2DShadow;

in vec3 vPosVS;
in vec3 vNormalVS;
in vec2 vUV;
in vec3 vTangentVS;

out vec4 fragColor;

/* ---- 材质 ---- */
uniform vec3  uKa;            // 环境光反射系数
uniform vec3  uKd;            // 漫反射系数
uniform vec3  uKs;            // 镜面反射系数
uniform float uShininess;     // 高光指数 n
uniform float uReflect;       // 环境贴图混合比例（0 = 关）
uniform float uAlpha;         // 不透明度（E2 透明物体）
uniform float uToon;          // 1 = 卡通着色（E3）

/* ---- 三分量开关（要求 2）---- */
uniform float uUseAmbient;
uniform float uUseDiffuse;
uniform float uUseSpecular;

/* ---- 相机与全局环境 ---- */
uniform vec3  uEyePosVS;      // 视图空间下恒为 (0,0,0)，但保留以便切换世界空间调试
uniform vec3  uGlobalAmbient; // 环境光颜色

/* ---- 光源：方向光（索引 0）+ 点光（索引 1）---- */
uniform int   uNumLights;
uniform int   uLightType[2];       // 0=方向光 1=点光
uniform vec3  uLightPosVS[2];      // 点光位置（视图空间）；方向光不使用
uniform vec3  uLightDirVS[2];      // 方向光传播方向（视图空间，已归一化）
uniform vec3  uLightColor[2];      // 颜色 × 强度（预先在 CPU 端乘好）
uniform vec3  uLightAtten[2];      // 点光衰减系数 (const, linear, quad)

/* ---- 纹理 ---- */
uniform sampler2D uTex;            // 普通位图纹理
uniform sampler2D uNormalMap;      // 法线贴图（E1）
uniform samplerCube uEnvMap;       // 环境贴图（要求 4）
uniform float uHasTex;
uniform float uHasNormalMap;
uniform float uNormalStrength;
uniform vec2  uUVScale;            // UV 平铺倍数（大平面用，避免一张贴图糊满）
uniform float uEnvMode;            // 0=无 1=反射 2=折射

/* ---- 阴影（要求 5）---- */
uniform sampler2DShadow uShadowMap;   // 深度纹理（硬件比较）
uniform mat4  uLightVP;               // 光源视角的 view*projection
uniform float uShadowEnabled;
uniform float uShadowTexel;           // 1/mapSize，PCF 采样步长
uniform float uShadowBias;
uniform float uPCF;                   // 1 = 开 3×3 PCF
uniform float uShadowAmbient;         // 阴影处的补光，避免全黑

/* ==========================================================================
 * 2×2 矩阵求逆：把法线贴图的切线空间法线转到视图空间
 * ========================================================================== */
mat2 inv2(mat2 m){
  float d = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  return mat2(m[1][1], -m[0][1], -m[1][0], m[0][0]) / max(d, 1e-8);
}

/* ==========================================================================
 * 阴影查表：返回 0（全在阴影）~1（全亮）
 *
 * uShadowMap 是 sampler2DShadow，texture() 会自动做
 * 「depth 与 [depth, depth+1/65536] 比较 + 双线性插值」，
 * 得到的就是部分遮挡比例，比手动 clamp 更平滑。
 * ========================================================================== */
float shadowFactor(){
  if(uShadowEnabled < 0.5) return 1.0;

  vec4 lightSpace = uLightVP * vec4(vPosVS, 1.0);   // 注意：这里用视图空间位置
  /* uLightVP 已经在 CPU 端乘好了 view 矩阵，见 shadow.js 的说明 */

  vec3 proj = lightSpace.xyz / lightSpace.w;
  proj = proj * 0.5 + 0.5;          // NDC [-1,1] → [0,1]

  /* 超出光源视锥就不管，视为全亮 */
  if(proj.x < 0.0 || proj.x > 1.0 || proj.y < 0.0 || proj.y > 1.0 || proj.z > 1.0){
    return 1.0;
  }

  float bias = uShadowBias;
  if(uPCF < 0.5){
    /* 单点采样：边缘会有明显锯齿（用于演示 panel 里关掉 PCF 的效果）*/
    return texture(uShadowMap, vec3(proj.xy, proj.z - bias));
  }

  /* 3×3 PCF：在相邻 9 个纹素各查一次，取平均 → 软阴影边缘 */
  float sum = 0.0;
  for(int y = -1; y <= 1; y++){
    for(int x = -1; x <= 1; x++){
      vec2 off = vec2(float(x), float(y)) * uShadowTexel;
      sum += texture(uShadowMap, vec3(proj.xy + off, proj.z - bias));
    }
  }
  return sum / 9.0;
}

void main(){
  /* ---------------------------------------------------------------
   * 1. 准备基础向量
   * --------------------------------------------------------------- */
  vec3 N = normalize(vNormalVS);
  vec3 V = normalize(uEyePosVS - vPosVS);   // 视图空间：V = normalize(-pos)

  /* ---------------------------------------------------------------
   * 2. 法线贴图（E1）：把切线空间法线转到视图空间
   * ---------------------------------------------------------------
   * 切线空间的三个基：T（切线）、B = N×T（副切线）、N（法线）。
   * 采样得到的 rgb 在 [0,1]，映射到 [-1,1] 才是法线分量。
   *
   * 这里用 Gram-Schmidt 正交化，因为 uNormalMatrix 变换后的切线
   * 可能不再严格垂直于法线（非等比缩放下）。
   */
  if(uHasNormalMap > 0.5){
    vec3 T = normalize(vTangentVS);
    T = normalize(T - dot(T, N) * N);      // 施密特正交化
    vec3 B = cross(N, T);
    vec3 nTex = texture(uNormalMap, vUV).xyz * 2.0 - 1.0;
    nTex.xy *= uNormalStrength;            // 强度调节
    N = normalize(mat3(T, B, N) * nTex);
  }

  /* ---------------------------------------------------------------
   * 3. 基础反照率
   * --------------------------------------------------------------- */
  vec4 texel = vec4(1.0);
  if(uHasTex > 0.5){
    texel = texture(uTex, vUV * uUVScale);
  }
  /* 纹理只做乘法着色（不用 mix 往白色里拽），
     这样深色纹理不会因为和白色混合而变灰、失去对比。 */
  vec3 albedo = uKd * texel.rgb;
  float alpha = uAlpha * texel.a;

  /* ---------------------------------------------------------------
   * 4. Phong 三分量累加
   * --------------------------------------------------------------- */
  vec3 ambient  = vec3(0.0);
  vec3 diffuse  = vec3(0.0);
  vec3 specular = vec3(0.0);

  for(int i = 0; i < 2; i++){
    if(i >= uNumLights) break;

    vec3 L;            // 从着色点指向光源
    vec3 lightColor = uLightColor[i];
    float atten = 1.0;

    if(uLightType[i] == 0){
      /* 方向光：方向与位置无关，无衰减 */
      L = normalize(-uLightDirVS[i]);
    } else {
      /* 点光：有位置、按距离衰减 */
      vec3 toLight = uLightPosVS[i] - vPosVS;
      float dist = length(toLight);
      L = toLight / max(dist, 1e-5);
      atten = 1.0 / (uLightAtten[i].x
                   + uLightAtten[i].y * dist
                   + uLightAtten[i].z * dist * dist);
    }

    float NdotL = max(dot(N, L), 0.0);

    /* ---- 漫反射：kd · (N·L) ---- */
    diffuse += uKd * lightColor * NdotL * atten;

    /* ---- 镜面：ks · (R·V)^n ---- *
     * R = 2(N·L)N − L，是 L 关于 N 的镜像。
     * 教材 Ch6 的原始 Phong 用 R·V；Blinn 用 H=(L+V)/|L+V| 与 N·H，
     * 后者更快但高光形状略不同。E3 的对比就是这两种的差别。 */
    if(NdotL > 0.0){
      vec3 R = reflect(-L, N);
      float RdotV = max(dot(R, V), 0.0);
      specular += uKs * lightColor * pow(RdotV, uShininess) * atten;
    }
  }

  /* ---- 环境光：ka · Ia ---- *
   * 阴影区域也要给一点环境光，否则背光面纯黑看不出形状。 */
  ambient = uKa * uGlobalAmbient;

  /* ---- 阴影：只衰减「直接光照」部分，环境光不受影响 ---- */
  float shadow = shadowFactor();
  float lit = mix(uShadowAmbient, 1.0, shadow);

  /* ---- 三个分量按开关取舍 ---- *
   * 【纹理只乘一次】
   * diffuse 里已经含了 uKd，这里再乘 albedo 就等于 kd² × 纹理，
   * 亮色材质会被推爆成白块。所以改成：
   *   先按 kd 归一（把 kd·texture 拆成 kd 与 texture 两部分），
   *   三分量累加完，最后统一乘一次贴图色，纹理才不会被重复放缩。 */
  vec3 color = vec3(0.0);
  vec3 kdSafe = max(uKd, vec3(1e-3));
  /* 环境光本来就是 ka·Ia，里面不含 kd，所以不需要除以 kd。
     直接乘 albedo 会让「ka=0.5 的浅色墙」变成 0.5×0.86×贴图，暗部死黑；
     这里保留 ambient 自身的量级，暗面才有细节。 */
  /* 环境光只被阴影削掉三成：环境光是「四周散射过来的光」，
     本来就不该被一张平行光的阴影图完全抹掉，
     否则物体背光 + 自阴影的那一面会变成纯黑板块。 */
  if(uUseAmbient  > 0.5) color += ambient * mix(0.72, 1.0, shadow);
  if(uUseDiffuse  > 0.5) color += (diffuse / kdSafe) * lit;
  if(uUseSpecular > 0.5) color += (specular / kdSafe) * lit;

  /* 统一乘一次反照率（材质色 × 贴图色）——纹理细节到这里才落到像素上 */
  color *= albedo;

  /* ---------------------------------------------------------------
   * 5. 环境贴图反射（要求 4，教材 7.6）
   * ---------------------------------------------------------------
   * 视线经法线反射得到方向 R，用 R 采样 cubemap。
   * 反射向量在【视图空间】算，所以 cubemap 也需要是视图空间的——
   * 这正是「天空盒跟着相机转」的效果，也正是反射应有的表现。
   */
  /* 环境贴图反射也归到「镜面」这一类：它本质上是完全镜面反射方向上的颜色。
     关掉镜面分量时一并关掉它，三分量对比才干净，
     否则「仅环境光」那张图里镜面球还在映窗户，读者会以为环境光带反射。 */
  if(uReflect > 0.001 && uEnvMode > 0.5 && uUseSpecular > 0.5){
    vec3 I = normalize(vPosVS - uEyePosVS);
    vec3 Rv;
    if(uEnvMode < 1.5){
      Rv = reflect(I, N);           // 反射
    } else {
      Rv = refract(I, N, 0.72);     // 折射（备用）
    }
    vec3 envColor = texture(uEnvMap, Rv).rgb;
    /* 反射率高的物体（镜子）连纹理细节都该被盖住；
       反射率低的（金属圆柱）让纹理透出来一点。 */
    color = mix(color, envColor, uReflect);
  }

  /* ---------------------------------------------------------------
   * 6. 卡通着色（E3）：把连续的光照量化成几档
   * --------------------------------------------------------------- */
  if(uToon > 0.5){
    /* 【量化对象很关键】
       一开始用 diffuse 的亮度去量化，但 diffuse 是「累加的最终光照」，
       数值常常小于 1，floor(lum*4)/4 会被压到 1~2 档，整体发灰发暗，
       完全看不出「卡通」的分色块感觉。

       正确做法是量化【N·L 本身】：它与材质颜色无关，范围稳定在 0~1，
       量化后能得到清晰的 3~4 档色阶。 */
    float ndl = 0.0;
    for(int i = 0; i < 2; i++){
      if(i >= uNumLights) break;
      vec3 L;
      if(uLightType[i] == 0){
        L = normalize(-uLightDirVS[i]);
      } else {
        L = normalize(uLightPosVS[i] - vPosVS);
      }
      ndl = max(ndl, dot(N, L));
    }

    float steps = 3.0;
    /* 加 0.5/steps 让色阶边界落在区间中点，避免最暗档占比过大 */
    float toonDiff = floor(ndl * steps + 0.5) / steps;
    toonDiff = clamp(toonDiff, 0.32, 1.0);

    /* 注意：此时 color 已经是「反照率之后」的值，卡通分支直接覆盖它，
       所以这里自己乘一次 albedo，不要沿用上面的 color。 */
    /* 卡通分支的基色要拉满，否则暗面档位全挤在 0~0.2 之间看不出分界。
       uKa*uGlobalAmbient 这项只是给暗面留一点底色，权重不能太大，
       不然分档就被它糊平了。 */
    /* 卡通渲染的阴影也用「硬阴影」：lit 在 0.2~1 之间做阶跃，
       而不是像 Phong 那样连续压暗。这样明暗交界线是一条硬边，
       和色阶一起构成卡通感。 */
    float toonLit = mix(0.42, 1.0, step(0.5, shadow));
    color = albedo * (0.10 + 0.95 * toonDiff) * toonLit;

    /* 硬边高光：超过阈值就是纯白，无衰减——卡通渲染的标志性特征 */
    float specMask = step(0.70, dot(specular, vec3(0.333)));
    color += specMask * 0.45 * mix(vec3(1.0), albedo, 0.5);
  }

  fragColor = vec4(color, alpha);
}
`;

/* ==========================================================================
 * 二、阴影深度着色器（第一遍渲染，要求 5）
 * --------------------------------------------------------------------------
 * 只输出深度，片元着色器可以什么都不做——
 * 深度由 GPU 自动写入深度附件。
 * 判断「必须写片元着色器」：WebGL2 允许只给顶点着色器，但为了显式
 * 绑定 out 变量、避免某些驱动的告警，还是写一个空的。
 * ========================================================================== */
SHADERS.depthVS = `#version 300 es
precision highp float;
in vec3 aPosition;
uniform mat4 uLightVP;
uniform mat4 uModel;
void main(){
  gl_Position = uLightVP * uModel * vec4(aPosition, 1.0);
}
`;

SHADERS.depthFS = `#version 300 es
precision highp float;
void main(){
  /* 深度自动写入深度附件，这里无需输出颜色 */
}
`;

/* ==========================================================================
 * 三、拾取着色器（要求 6）
 * --------------------------------------------------------------------------
 * 颜色编码拾取：每个物体渲染成「ID 对应的纯色」，关闭光照与纹理，
 * 读回像素颜色即可反解物体编号。
 *
 * 为什么用 readPixels 而不是射线求交？
 *   · 颜色编码：GPU 自动处理遮挡、透明、非凸形状，实现只需几十行；
 *   · 射线求交：需要为每种几何体写解析求交，球/盒/柱/环各一套，容易出错。
 * 代价：每次点击要一次 readPixels（同步，约 1ms），对交互足够了。
 * ========================================================================== */
SHADERS.pickVS = `#version 300 es
precision highp float;
in vec3 aPosition;
uniform mat4 uModelView;
uniform mat4 uProjection;
void main(){
  gl_Position = uProjection * uModelView * vec4(aPosition, 1.0);
}
`;

SHADERS.pickFS = `#version 300 es
precision highp float;
uniform vec3 uPickColor;
out vec4 fragColor;
void main(){
  fragColor = vec4(uPickColor, 1.0);
}
`;

/* ==========================================================================
 * 四、选中描边着色器（要求 6 的高亮）
 * --------------------------------------------------------------------------
 * 做法：用一个略微放大的「壳」几何体，沿法线外扩，只画背面，
 * 关闭深度写入。这样壳只会在物体轮廓外露出一圈，形成描边。
 * 这是最省事的描边方案，不依赖后期处理的边缘检测。
 * ========================================================================== */
SHADERS.outlineVS = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec3 aNormal;
uniform mat4 uModelView;
uniform mat4 uProjection;
uniform mat3 uNormalMatrix;
uniform float uOutlineWidth;
void main(){
  /* 沿法线外扩：乘以法线矩阵保证非等比缩放下外扩量仍沿表面法线 */
  vec3 offset = normalize(uNormalMatrix * aNormal) * uOutlineWidth;
  vec4 posVS = uModelView * vec4(aPosition, 1.0);
  posVS.xyz += offset;
  gl_Position = uProjection * posVS;
}
`;

SHADERS.outlineFS = `#version 300 es
precision highp float;
uniform vec4 uColor;
out vec4 fragColor;
void main(){
  fragColor = uColor;
}
`;

/* ==========================================================================
 * 五、天空盒着色器（环境贴图的视觉背景）
 * --------------------------------------------------------------------------
 * 把 cubemap 画在一个大立方体内部，深度写为 1.0 让它永远在最远处。
 * 注意视图矩阵要「去掉平移」，否则天空盒会跟着相机移动而露馅。
 * ========================================================================== */
SHADERS.skyVS = `#version 300 es
precision highp float;
in vec3 aPosition;
uniform mat4 uProjection;
uniform mat4 uViewRotOnly;   // 只含旋转的视图矩阵
out vec3 vDir;
void main(){
  vDir = aPosition;
  vec4 p = uProjection * uViewRotOnly * vec4(aPosition, 1.0);
  gl_Position = p.xyww;      // z=w → 深度恒为 1（最远）
}
`;

SHADERS.skyFS = `#version 300 es
precision highp float;
precision highp samplerCube;
in vec3 vDir;
uniform samplerCube uEnvMap;
out vec4 fragColor;
void main(){
  fragColor = vec4(texture(uEnvMap, normalize(vDir)).rgb, 1.0);
}
`;
