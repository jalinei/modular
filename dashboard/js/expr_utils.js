(function(){
    const buffers = new WeakMap();
    function getBuffer(fn){
        let buf = buffers.get(fn);
        if(!buf){
            buf = [];
            buffers.set(fn, buf);
        }
        return buf;
    }
    window.mean = function(value, windowSize){
        windowSize = parseInt(windowSize);
        if(isNaN(windowSize) || windowSize <= 0) windowSize = 10;
        const caller = window.mean.caller || arguments.callee.caller;
        const buffer = getBuffer(caller || window.mean);
        buffer.push(value);
        if(buffer.length > windowSize){
            buffer.shift();
        }
        const sum = buffer.reduce((a,b)=>a+b,0);
        return buffer.length ? sum / buffer.length : 0;
    };
})();
