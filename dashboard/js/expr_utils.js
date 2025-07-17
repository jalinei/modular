(function(){
    const buffers = new Map();

    function getKey(){
        const err = new Error();
        if(err.stack){
            const lines = err.stack.split("\n");
            // When called from mean() via this helper, the caller is
            // three frames up the stack.
            if(lines.length >= 4){
                return lines[3].trim();
            } else if(lines.length >= 3){
                return lines[2].trim();
            }
        }
        return window.mean.caller || arguments.callee.caller;
    }

    function getBuffer(key){
        let buf = buffers.get(key);
        if(!buf){
            buf = [];
            buffers.set(key, buf);
        }
        return buf;
    }

    window.mean = function(value, windowSize){
        windowSize = parseInt(windowSize);
        if(isNaN(windowSize) || windowSize <= 0) windowSize = 10;
        const key = getKey();
        const buffer = getBuffer(key);
        buffer.push(value);
        if(buffer.length > windowSize){
            buffer.shift();
        }
        const sum = buffer.reduce((a,b)=>a+b,0);
        return buffer.length ? sum / buffer.length : 0;
    };
})();
