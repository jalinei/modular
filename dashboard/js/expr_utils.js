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

    function getEntry(key){
        let entry = buffers.get(key);
        if(!entry){
            entry = { size: 0, buffer: [] };
            buffers.set(key, entry);
        }
        return entry;
    }

    window.mean = function(value, windowSize){
        windowSize = parseInt(windowSize);
        if(isNaN(windowSize) || windowSize <= 0) windowSize = 10;
        const key = getKey();
        const entry = getEntry(key);

        if(entry.size !== windowSize){
            entry.size = windowSize;
            if(entry.buffer.length > windowSize){
                entry.buffer = entry.buffer.slice(-windowSize);
            }
        }

        entry.buffer.push(value);
        if(entry.buffer.length > entry.size){
            entry.buffer.shift();
        }
        const sum = entry.buffer.reduce((a,b)=>a+b,0);
        return entry.buffer.length ? sum / entry.buffer.length : 0;
    };
})();
