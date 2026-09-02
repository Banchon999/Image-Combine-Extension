import {stitchOptions,planStitch,partSlices} from '../../common/stitch-plan.js';
import {CancelledError} from '../../common/errors.js';

// One output canvas and one decoded source at a time. Inputs remain compressed in memory.
export async function* stitchPages(pages,settings,signal,onProgress=()=>{},io={}) {
  const decode=io.decode??(page=>createImageBitmap(new Blob([page.data],{type:page.mimeType})));
  const makeCanvas=io.makeCanvas??((w,h)=>new OffscreenCanvas(w,h));
  const check=()=>{if(signal?.aborted)throw new CancelledError();};
  const options=stitchOptions(settings),dimensions=[];
  for(let i=0;i<pages.length;i++) {
    check();onProgress(`Measuring image ${i+1}/${pages.length}`);
    const bitmap=await decode(pages[i]);
    try{check();dimensions.push({width:bitmap.width,height:bitmap.height});}finally{bitmap.close();}
  }
  const plan=planStitch(dimensions,options);
  let bitmap=null,sourceIndex=-1;
  try {
    for(let i=0;i<plan.parts.length;i++) {
      check();const part=plan.parts[i];
      onProgress(`Stitching ${i+1}/${plan.parts.length} · ${plan.width} × ${part.height}px${plan.resized?' · width adjusted':''}`);
      let canvas;
      try {
        canvas=makeCanvas(plan.width,part.height);
        const context=canvas.getContext('2d',{alpha:false});
        if(!context)throw new Error('No 2D canvas context.');
        context.fillStyle='#ffffff';context.fillRect(0,0,plan.width,part.height);
        for(const slice of partSlices(plan,part)) {
          check();
          if(sourceIndex!==slice.sourceIndex) {
            bitmap?.close();bitmap=null;
            bitmap=await decode(pages[slice.sourceIndex]);sourceIndex=slice.sourceIndex;
          }
          check();context.drawImage(bitmap,slice.sx,slice.sy,slice.sw,slice.sh,slice.dx,slice.dy,slice.dw,slice.dh);
        }
        check();const blob=await canvas.convertToBlob({type:options.mime,quality:options.quality});
        if(!blob?.size||blob.type!==options.mime)throw new Error(`Browser cannot encode ${options.mime}; choose another image type.`);
        check();yield {index:i+1,width:plan.width,height:part.height,mimeType:blob.type,data:new Uint8Array(await blob.arrayBuffer()),url:'',stitched:true};
      } catch(error) {
        if(error instanceof CancelledError)throw error;
        throw new Error(`Stitch part ${i+1}/${plan.parts.length} failed: ${error.message}. Try smaller width/height. Earlier separately saved parts may remain.`);
      } finally {if(canvas){canvas.width=1;canvas.height=1;}}
    }
  } finally {bitmap?.close();}
}
