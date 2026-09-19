import cvModule from '@techstark/opencv-js';
import sharp from 'sharp';
let cvReady;
async function ready(){if(!cvReady)cvReady=(async()=>{if(cvModule instanceof Promise)return {cv:await cvModule};if(!cvModule.Mat)await new Promise(r=>cvModule.onRuntimeInitialized=r);return {cv:cvModule};})();return cvReady;}
export async function mrzRegions(bytes){
 const {cv}=await ready();const output=[];
 for(const angle of [0,90]){
  const {data,info}=await sharp(bytes,{limitInputPixels:40000000}).rotate(angle).resize({width:1200,height:1200,fit:'inside'}).grayscale().raw().toBuffer({resolveWithObject:true});
  const full=await sharp(bytes,{limitInputPixels:40000000}).rotate(angle).resize({width:2400,height:2400,fit:'inside',withoutEnlargement:true}).grayscale().raw().toBuffer({resolveWithObject:true});
  const scale=full.info.width/info.width;
  const mats=[],keep=m=>(mats.push(m),m);
  try{
   const src=keep(cv.matFromArray(info.height,info.width,cv.CV_8UC1,data)),original=keep(cv.matFromArray(full.info.height,full.info.width,cv.CV_8UC1,full.data)),black=keep(new cv.Mat()),grad=keep(new cv.Mat()),mask=keep(new cv.Mat());
   const rect=keep(cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(31,9))),join=keep(cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(41,17)));
   cv.GaussianBlur(src,src,new cv.Size(3,3),0);
   cv.morphologyEx(src,black,cv.MORPH_BLACKHAT,rect);
   cv.Sobel(black,grad,cv.CV_32F,1,0,-1);cv.convertScaleAbs(grad,grad,1/16);cv.normalize(grad,grad,0,255,cv.NORM_MINMAX);
   cv.morphologyEx(grad,mask,cv.MORPH_CLOSE,rect);cv.threshold(mask,mask,0,255,cv.THRESH_BINARY|cv.THRESH_OTSU);cv.morphologyEx(mask,mask,cv.MORPH_CLOSE,join);

   const candidates=[];
   const horizontal=keep(cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(23,5)));
   for(const level of [null,80,120,160,200,'adaptive']){
    if(level!==null){if(level==='adaptive')cv.adaptiveThreshold(src,mask,255,cv.ADAPTIVE_THRESH_GAUSSIAN_C,cv.THRESH_BINARY_INV,31,12);else cv.threshold(src,mask,level,255,cv.THRESH_BINARY_INV);cv.morphologyEx(mask,mask,cv.MORPH_CLOSE,horizontal);}
    const contours=keep(new cv.MatVector()),hierarchy=keep(new cv.Mat());cv.findContours(mask,contours,hierarchy,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE);
    for(let i=0;i<contours.size();i++){const c=contours.get(i);const r=cv.minAreaRect(c);c.delete();let w=r.size.width,h=r.size.height,a=r.angle;if(h>w){[w,h]=[h,w];a+=90;}if(a>90)a-=180;
     if(w>info.width*.35&&w/h>5&&h>8&&Math.abs(a)<20&&!candidates.some(c=>Math.abs(c.cx-r.center.x)<10&&Math.abs(c.cy-r.center.y)<10&&Math.abs(c.a-a)<2&&Math.abs(c.h-h)<10))candidates.push({cx:r.center.x,cy:r.center.y,w,h,a});
    }
   }
   candidates.sort((a,b)=>b.w-a.w);
   for(const c of candidates.slice(0,10)){
    const w=Math.min(info.width,Math.ceil(c.w*1.08)),h=Math.ceil(c.h*2.4+20),rad=c.a*Math.PI/180;
    const outW=Math.round(w*scale),outH=Math.round(h*scale);
    const points=[[-w/2,-h/2],[w/2,-h/2],[w/2,h/2],[-w/2,h/2]].flatMap(([x,y])=>[c.cx+x*Math.cos(rad)-y*Math.sin(rad),c.cy+x*Math.sin(rad)+y*Math.cos(rad)]);
    const from=keep(cv.matFromArray(4,1,cv.CV_32FC2,points.map(v=>v*scale))),to=keep(cv.matFromArray(4,1,cv.CV_32FC2,[0,0,outW,0,outW,outH,0,outH])),transform=keep(cv.getPerspectiveTransform(from,to)),crop=keep(new cv.Mat());cv.warpPerspective(original,crop,transform,new cv.Size(outW,outH),cv.INTER_CUBIC,cv.BORDER_CONSTANT,new cv.Scalar(255));
    const png=await sharp(Buffer.from(crop.data),{raw:{width:outW,height:outH,channels:1}}).resize({width:2200}).normalize().png().toBuffer();output.push({image:png,angle,box:c});
   }
  }finally{for(const m of mats.reverse())m.delete();}
 }
 return output;
}
