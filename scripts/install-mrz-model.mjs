import {mkdir,readFile,writeFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const target=new URL('../.ocr-model/mrz.traineddata',import.meta.url);
const hash='ece2a54f125a73792f9cec74e6f8e62f6e5e00c7f19153ba865af689be5b5f01';
const valid=b=>createHash('sha256').update(b).digest('hex')===hash;
let existing;try{existing=await readFile(target);}catch{}
if(!existing||!valid(existing)){
 const response=await fetch('https://raw.githubusercontent.com/DoubangoTelecom/tesseractMRZ/1e7adfecda5f3c9ae1fb12cf6b4b8c3958c63e46/tessdata_fast/mrz.traineddata',{signal:AbortSignal.timeout(60000)});
 if(!response.ok)throw Error('Unable to download pinned MRZ model');const bytes=Buffer.from(await response.arrayBuffer());if(!valid(bytes))throw Error('MRZ model checksum mismatch');
 await mkdir(new URL('../.ocr-model/',import.meta.url),{recursive:true});await writeFile(target,bytes);
}
console.log('Pinned MRZ model ready');
