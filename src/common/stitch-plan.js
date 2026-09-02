// Fixed desktop-oriented application limits, NOT detected browser/RAM limits.
// A full 256 Mi-pixel RGBA canvas alone can consume 1 GiB before encoding.
export const STITCH_LIMITS = Object.freeze({maxWidth:32767,maxHeight:32767,maxPixels:268435456,maxParts:2000});
export const STITCH_DEFAULTS = Object.freeze({stitchEnabled:false,stitchMode:'smart',stitchHeight:18000,stitchCount:4,stitchWidth:0,stitchMime:'image/jpeg',stitchQuality:95});

export function stitchCodecLimits(mime) {
  return mime==='image/webp' ? {...STITCH_LIMITS,maxWidth:16383,maxHeight:16383} : STITCH_LIMITS;
}

export function stitchOptions(input = {}) {
  const s={...STITCH_DEFAULTS,...input};
  const integer=(value,min,max,label)=>{
    const n=Number(value);
    if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`${label} must be ${min}–${max}.`);
    return n;
  };
  if(!['smart','height','count'].includes(s.stitchMode))throw new Error('Unknown image split mode.');
  if(!['image/jpeg','image/png','image/webp'].includes(s.stitchMime))throw new Error('Choose JPG, PNG or WebP.');
  const mime=s.format==='pdf'?'image/jpeg':s.stitchMime;
  const limits=stitchCodecLimits(mime);
  return {mode:s.stitchMode,width:integer(s.stitchWidth,0,limits.maxWidth,`${mime} width`),height:s.stitchMode==='smart'?limits.maxHeight:integer(s.stitchHeight,1,limits.maxHeight,`${mime} maximum height`),count:s.stitchMode==='count'?integer(s.stitchCount,1,2000,'Image count'):0,mime,quality:integer(s.stitchQuality,1,100,'Image quality')/100};
}

export function planStitch(dimensions,options,limits=STITCH_LIMITS) {
  const codec=stitchCodecLimits(options.mime);
  limits={...limits,maxWidth:Math.min(limits.maxWidth,codec.maxWidth),maxHeight:Math.min(limits.maxHeight,codec.maxHeight)};
  if(!dimensions.length)throw new Error('No images to stitch.');
  for(const image of dimensions)if(![image.width,image.height].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('Invalid source dimensions.');
  const width=options.width||Math.min(...dimensions.map(image=>image.width));
  if(width>limits.maxWidth)throw new Error(`Width ${width} is too large. Set width to ${limits.maxWidth} or less.`);
  const safeHeight=Math.min(limits.maxHeight,Math.floor(limits.maxPixels/width));
  const cap=Math.min(options.height,safeHeight);
  if(options.mode==='height'&&options.height>safeHeight)throw new Error(`At width ${width}, maximum height is ${safeHeight}px. Reduce height/width or choose Smart.`);
  let totalHeight=0;
  const sources=dimensions.map(image=>{
    const height=Math.max(1,Math.round(image.height*width/image.width));
    const source={...image,top:totalHeight,scaledHeight:height};totalHeight+=height;return source;
  });
  if(!Number.isSafeInteger(totalHeight))throw new Error('Chapter height is too large.');
  let heights;
  if(options.mode==='count') {
    const minimum=Math.ceil(totalHeight/cap);
    if(options.count<minimum)throw new Error(`Need at least ${minimum} images at height ≤ ${cap}px. Increase count or change width/height.`);
    if(options.count>totalHeight)throw new Error('More output images than pixel rows. Reduce image count.');
    const base=Math.floor(totalHeight/options.count),remainder=totalHeight%options.count;
    heights=Array.from({length:options.count},(_,i)=>base+(i<remainder?1:0));
  } else {
    const count=Math.ceil(totalHeight/cap);
    if(count>limits.maxParts)throw new Error('Too many output images. Increase height.');
    heights=Array.from({length:count},(_,i)=>Math.min(cap,totalHeight-i*cap));
  }
  if(heights.length>limits.maxParts)throw new Error('Too many output images.');
  let top=0;
  const parts=heights.map(height=>{const part={top,height};top+=height;return part;});
  return {width,totalHeight,sources,parts,safeHeight,resized:dimensions.some(image=>image.width!==width)};
}

export function partSlices(plan,part) {
  const end=part.top+part.height;
  return plan.sources.flatMap((source,sourceIndex)=>{
    const start=Math.max(source.top,part.top),stop=Math.min(source.top+source.scaledHeight,end);
    if(stop<=start)return [];
    const ratio=source.height/source.scaledHeight;
    return [{sourceIndex,sx:0,sy:(start-source.top)*ratio,sw:source.width,sh:(stop-start)*ratio,dx:0,dy:start-part.top,dw:plan.width,dh:stop-start}];
  });
}
