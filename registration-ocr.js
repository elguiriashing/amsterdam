import {fileURLToPath} from 'node:url';
import {mrzRegions} from './mrz-regions.js';
import {cleanMrz} from './mrz-image.js';
import {dirname} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
import {parse,states} from 'mrz';
import sharp from 'sharp';
import {createWorker} from 'tesseract.js';
import {InputError,adult} from './registration-domain.js';
export const ocrLanguages={eng:'English / international MRZ',spa:'Spanish',fra:'French',deu:'German',ita:'Italian',por:'Portuguese',nld:'Dutch',pol:'Polish',ron:'Romanian',tur:'Turkish',ell:'Greek',rus:'Russian',ukr:'Ukrainian',ara:'Arabic',heb:'Hebrew',hin:'Hindi',chi_sim:'Chinese (simplified)',chi_tra:'Chinese (traditional)',jpn:'Japanese',kor:'Korean',tha:'Thai'};
const labels={surname:'SURNAME|LAST NAME|FAMILY NAME|APELLIDOS?|NOM(?: DE FAMILLE)?|NACHNAME|COGNOME|SOBRENOME|ACHTERNAAM',firstName:'GIVEN NAMES?|FIRST NAMES?|FORENAMES?|NOMBRES?|PRENOMS?|VORNAMEN?|NOME|VOORNAMEN?',documentNumber:'PASSPORT(?: NO| NUMBER| NR)?|DOCUMENT(?: NO| NUMBER)?|ID(?: NO| NUMBER)?|IDENTITY NUMBER|DNI|NIE|NUMERO DE DOCUMENTO|NUMERO DE PASAPORTE|DOCUMENTO|PASSAPORTO|REISEPASS(?:NUMMER)?',dob:'DATE OF BIRTH|BIRTH DATE|DOB|FECHA DE NACIMIENTO|NACIMIENTO|DATE DE NAISSANCE|GEBURTSDATUM|DATA DI NASCITA'};
const folded=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
function birth(s){if(!/^\d{6}$/.test(s||''))return;const yy=+s.slice(0,2);for(const century of [2000,1900]){const d=`${century+yy}-${s.slice(2,4)}-${s.slice(4,6)}`;if(adult(d))return d;}}
export function extractIdentity(raw){
 const suggestions={},warnings=[];let format=null,valid=false;
 const lines=String(raw).slice(0,20000).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
 const normalized=lines.map(s=>s.toUpperCase().replace(/[«‹]/g,'<').replace(/\s/g,''));
 const mrz=[];
 for(let line of normalized){
  const passportStart=line.search(/P[<A-Z][A-Z]{3}[A-Z]{2,}<</);if(passportStart>0&&passportStart<4)line=line.slice(passportStart);
  if(/^P/.test(line)&&line.includes('<<'))line=line.replace(/(<{4,})[0-9].*$/,'$1');
  if(/^[PF]/.test(line)&&line.includes('<<')){
   // OCR often drops trailing filler marks, or confuses the passport type glyph.
   const country=[1,2].find(i=>Object.hasOwn(states,line.slice(i,i+3))&&line.slice(i+3).includes('<<'));
   if(country!==undefined&&line.length>=28&&line.length<=46){line='P<'+line.slice(country);if(line.length>44&&/^<+$/.test(line.slice(44)))line=line.slice(0,44);line=line.padEnd(44,'<');}
  }
  if(mrz.at(-1)?.startsWith('P<')&&/^[A-Z0-9<]{9}\d[A-Z<]{3}[A-Z0-9]{7}[MF<]/.test(line)&&line.length>=30&&line.length<44)line=line.slice(0,-2)+'<'.repeat(44-line.length)+line.slice(-2);
  if(/^[A-Z0-9<]{28,44}$/.test(line))mrz.push(line);
 }
 for(let i=0;i<mrz.length;i++)for(const count of [3,2]){try{
  const r=parse(mrz.slice(i,i+count),{autocorrect:true});if(!['TD1','TD2','TD3'].includes(r.format))continue;if(!r.fields.lastName&&!r.fields.firstName)continue;
  const candidate={};if(r.fields.firstName)candidate.firstName=r.fields.firstName;if(r.fields.lastName)candidate.surname=r.fields.lastName;
  // Never fill a document number or date whose check digit failed.
  const check=field=>!r.details.some(d=>d.field===field&&d.valid===false);
  if(r.documentNumber&&check('documentNumberCheckDigit'))candidate.documentNumber=r.documentNumber;
  const dob=birth(r.fields.birthDate);if(dob&&check('birthDateCheckDigit'))candidate.dob=dob;
  if(Object.keys(candidate).length>Object.keys(suggestions).length||r.valid){Object.assign(suggestions,candidate);format=r.format;valid=r.valid;}
  if(r.valid)break;
 }catch{}}
 if(format&&!valid)warnings.push('Some machine-readable checks failed. Check the suggested fields against the original.');
 if(!format){for(let i=0;i<lines.length;i++)for(const [field,label]of Object.entries(labels)){
  const match=folded(lines[i]).match(new RegExp(`^(?:${label})(?:\\s*[:.#/-]\\s*|\\s+|$)(.*)$`));if(!match)continue;
  let value=match[1].trim()||lines[i+1]||'';
  if(Object.values(labels).some(l=>new RegExp(`^(?:${l})(?:[:. /]|$)`).test(folded(value))))continue;
  if(field==='documentNumber'){value=folded(value).replace(/^(?:NO|NUMBER|NR)\.?\s*[:.]?\s*/,'');if(!/^[A-Z0-9][A-Z0-9 .-]{2,39}$/.test(value)||!/[0-9]/.test(value))continue;}
  else if(field==='dob'){const m=value.match(/\b(\d{4})[-/.](\d{2})[-/.](\d{2})\b/);if(!m)continue;value=`${m[1]}-${m[2]}-${m[3]}`;if(!adult(value))continue;}
  else if(!/^[\p{L}\p{M} '\u2019-]{2,120}$/u.test(value))continue;
  suggestions[field]=value;
 }warnings.push('Printed-text suggestions have no machine-readable checksum. Verify them before saving.');}
 const missing=['firstName','surname','documentNumber'].filter(k=>!suggestions[k]);if(missing.length)warnings.push('Not confidently found: '+missing.join(', ')+'. Try the other side or a clearer close-up.');
 return {suggestions,format,valid,warnings};
}
let busy=false;
export async function scanIdentity(bytes,language='eng'){
 if(!Object.hasOwn(ocrLanguages,language))throw new InputError('Choose a supported scan language.');
 if(busy)throw new InputError('Another ID scan is running. Try again shortly.',429);busy=true;
 let worker,timer,expired=false,best=null,bestScore=-1;
 const update=data=>{const result=extractIdentity(data.text);if((data.confidence||0)<45){delete result.suggestions.firstName;delete result.suggestions.surname;result.warnings.push('Name text is unclear. Check the photo or enter the name manually.');}const score=Object.keys(result.suggestions).length*1000+(result.suggestions.documentNumber?5000:0)+(data.confidence||0);if(score>bestScore){bestScore=score;best={...result,text:data.text.slice(0,6000),confidence:data.confidence};}return result;};
 const job=(async()=>{
  const regions=await mrzRegions(bytes);
  worker=await createWorker('mrz',1,{langPath:fileURLToPath(new URL('./.ocr-model/',import.meta.url)),gzip:false,cacheMethod:'none',logger:()=>{},errorHandler:()=>{}});
  await worker.setParameters({tessedit_pageseg_mode:'6',tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<',user_defined_dpi:'300'});
  for(const region of regions){for(const flip of [false,true]){
   if(expired)throw new Error('Expired');
   const image=flip?await sharp(region.image).rotate(180).toBuffer():region.image;
   let promising=false;
   {const {data}=await worker.recognize(await sharp(image).threshold(200).png().toBuffer(),{rotateAuto:true});update(data);}
   for(const threshold of [160,200,100]){const {data}=await worker.recognize(await sharp(image).threshold(threshold).png().toBuffer());update(data);if((data.text.match(/</g)||[]).length>5&&/[A-Z]{3}/.test(data.text))promising=true;}
   if(promising){
    for(const threshold of [80,180,200]){if(expired)throw new Error('Expired');const {data}=await worker.recognize(await sharp(image).threshold(threshold).png().toBuffer());update(data);}
    for(const threshold of [210,130]){if(expired)throw new Error('Expired');const {data}=await worker.recognize(await cleanMrz(image,threshold));update(data);}
   }
   if(best?.suggestions.documentNumber&&best.suggestions.firstName&&best.suggestions.surname&&best.confidence>=45)return best;
  }}
  await worker.terminate();worker=null;
  if(expired)throw new Error('Expired');
  worker=await createWorker(language==='eng'?'eng':`eng+${language}`,1,{logger:()=>{},errorHandler:()=>{},...(language==='eng'?{cacheMethod:'none',langPath:dirname(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'))}:{})});
  if(expired){await worker.terminate();throw new Error('Expired');}
  await worker.setParameters({tessedit_pageseg_mode:'3'});
  const base=await sharp(bytes,{limitInputPixels:40000000}).rotate().resize({width:2200,height:2200,fit:'inside'}).grayscale().normalize().toBuffer();

  for(const angle of [0,90,270,180]){
   if(expired)throw new Error('Expired');
   const image=angle?await sharp(base).rotate(angle).toBuffer():base;
   const {data}=await worker.recognize(image,{rotateAuto:true});const result=update(data);
   if(result.valid&&result.suggestions.documentNumber)break;
  }
  return best;
 })();
 try{return await Promise.race([job,new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new InputError('Scan timed out. Try a sharp, close-up photo with the document upright.',503));},80000);})]);}
 catch(e){if(expired&&best&&Object.keys(best.suggestions).length)return {...best,warnings:[...best.warnings,'Scan time limit reached; check the partial results.']};if(e instanceof InputError)throw e;throw new InputError('The scan could not complete. Try a clearer photo or another scan language.',503);}
 finally{clearTimeout(timer);if(worker)await worker.terminate().catch(()=>{});busy=false;}
}
