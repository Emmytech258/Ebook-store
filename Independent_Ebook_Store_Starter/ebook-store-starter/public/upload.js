export async function compressCover(file,maxSize=1280) {
  if(!file||!file.type.startsWith('image/'))throw new Error('Please choose an image for the cover.');
  if(file.size>20*1024*1024)throw new Error('Choose a cover image below 20 MB.');
  const bitmap=await createImageBitmap(file);
  try {
    let limit=maxSize,quality=.82;
    for(let attempt=0;attempt<5;attempt++) {
      const scale=Math.min(1,limit/Math.max(bitmap.width,bitmap.height)),canvas=document.createElement('canvas');
      canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',quality));
      if(!blob||blob.type!=='image/webp')throw new Error('Please use a recent version of Chrome, Edge or Firefox for cover uploads.');
      if(blob.size<=750*1024)return blob;
      limit=Math.round(limit*.8);quality-=.08;
    }
    throw new Error('This image is too large after compression. Please choose a smaller image.');
  }finally{bitmap.close();}
}
