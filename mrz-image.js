import sharp from 'sharp';
export async function cleanMrz(image,cutoff=170){
 const meta=await sharp(image).metadata();
 const {data,info}=await sharp(image).extract({left:Math.floor(meta.width*.025),top:0,width:Math.floor(meta.width*.95),height:meta.height}).resize({width:1800}).grayscale().raw().toBuffer({resolveWithObject:true});
 const bg=await sharp(data,{raw:{width:info.width,height:info.height,channels:1}}).blur(12).grayscale().raw().toBuffer();
 const output=Buffer.alloc(data.length);for(let i=0;i<data.length;i++)output[i]=data[i]*255/Math.max(1,bg[i])<cutoff?0:255;
 return sharp(output,{raw:{width:info.width,height:info.height,channels:1}}).extend({top:15,bottom:15,left:15,right:15,background:'white'}).png().toBuffer();
}
