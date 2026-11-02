function initShaders( gl, vertexShaderSource, fragmentShaderSource )
{
    var vshader = gl.createShader( gl.VERTEX_SHADER );
    gl.shaderSource( vshader, vertexShaderSource );
    gl.compileShader( vshader );
    if ( !gl.getShaderParameter(vshader, gl.COMPILE_STATUS) ) {
        var info = gl.getShaderInfoLog( vshader );
        alert( "顶点着色器编译错误:\n" + info + "\n---源码---\n" + vertexShaderSource );
        return null;
    }

    var fshader = gl.createShader( gl.FRAGMENT_SHADER );
    gl.shaderSource( fshader, fragmentShaderSource );
    gl.compileShader( fshader );
    if ( !gl.getShaderParameter(fshader, gl.COMPILE_STATUS) ) {
        var info = gl.getShaderInfoLog( fshader );
        alert( "片元着色器编译错误:\n" + info + "\n---源码---\n" + fragmentShaderSource );
        return null;
    }

    var program = gl.createProgram();
    gl.attachShader( program, vshader );
    gl.attachShader( program, fshader );
    gl.linkProgram( program );

    if ( !gl.getProgramParameter( program, gl.LINK_STATUS ) ) {
        var info = gl.getProgramInfoLog( program );
        alert( "程序链接错误:\n" + info );
        return null;
    }
    return program;
}
