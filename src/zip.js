const table=new Uint32Array(256);
for(let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[i]=c>>>0;}
const crcUpdate=(crc,bytes)=>{for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return crc>>>0;};
function record(size,fields){const arr=new Uint8Array(size),v=new DataView(arr.buffer);for(const [at,value,n] of fields){if(n===2)v.setUint16(at,value,true);else v.setUint32(at,value,true);}return arr;}
export function zipStream(entries,bucket) {
  const enc=new TextEncoder();let iterator;
  async function* generate(){
    const directory=[];let offset=0;
    for(const entry of entries){
      const name=enc.encode(entry.filename),begin=offset;
      const head=record(30,[[0,0x04034b50,4],[4,20,2],[6,0x0808,2],[26,name.length,2]]);
      yield head;yield name;offset+=head.length+name.length;
      const file=await bucket.get(entry.key);if(!file)throw new Error('A purchased PDF is unavailable.');
      let crc=0xffffffff,size=0;const reader=file.body.getReader();
      try{while(true){const {done,value}=await reader.read();if(done)break;crc=crcUpdate(crc,value);size+=value.length;offset+=value.length;yield value;}}finally{reader.releaseLock();}
      crc=(crc^0xffffffff)>>>0;
      const desc=record(16,[[0,0x08074b50,4],[4,crc,4],[8,size,4],[12,size,4]]);yield desc;offset+=desc.length;
      const central=record(46,[[0,0x02014b50,4],[4,20,2],[6,20,2],[8,0x0808,2],[16,crc,4],[20,size,4],[24,size,4],[28,name.length,2],[42,begin,4]]);
      directory.push(central,name);
    }
    const directoryStart=offset;
    for(const chunk of directory){yield chunk;offset+=chunk.length;}
    yield record(22,[[0,0x06054b50,4],[8,entries.length,2],[10,entries.length,2],[12,offset-directoryStart,4],[16,directoryStart,4]]);
  }
  return new ReadableStream({start(){iterator=generate();},async pull(controller){try{const item=await iterator.next();if(item.done)controller.close();else controller.enqueue(item.value);}catch(error){controller.error(error);}},async cancel(){await iterator.return();}});
}
