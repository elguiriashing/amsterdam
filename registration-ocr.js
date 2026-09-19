import {dirname} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
import {parse} from 'mrz';
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
 const mrz=lines.map(s=>s.toUpperCase().replace(/[«‹]/g,'<').replace(/\s/g,'')).filter(s=>/^[A-Z0-9<]{28,44}$/.test(s));
 for(let i=0;i<mrz.length;i++)for(const count of [3,2]){try{
  const r=parse(mrz.slice(i,i+count),{autocorrect:true});if(!r.fields.lastName&&!r.fields.firstName)continue;
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
 let worker,timer,expired=false;
 const job=(async()=>{
  worker=await createWorker(language==='eng'?'eng':`eng+${language}`,1,{logger:()=>{},errorHandler:()=>{},...(language==='eng'?{cacheMethod:'none',langPath:dirname(require.resolve('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'))}:{})});
  if(expired){await worker.terminate();throw new Error('Expired');}
  await worker.setParameters({tessedit_pageseg_mode:'3'});
  const base=await sharp(bytes,{limitInputPixels:40000000}).rotate().resize({width:2200,height:2200,fit:'inside'}).grayscale().normalize().toBuffer();
  let best=null,bestScore=-1;
  for(const angle of [0,90,270,180]){
   if(expired)throw new Error('Expired');
   const image=angle?await sharp(base).rotate(angle).toBuffer():base;
   const {data}=await worker.recognize(image,{rotateAuto:true});const result=extractIdentity(data.text);
   const score=Object.keys(result.suggestions).length*100+(result.valid?1000:0)+(data.confidence||0);
   if(score>bestScore){bestScore=score;best={...result,text:data.text.slice(0,6000),confidence:data.confidence};}
   if(result.valid&&result.suggestions.documentNumber)break;
  }
  return best;
 })();
 try{return await Promise.race([job,new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new InputError('Scan timed out. Try a sharp, close-up photo with the document upright.',503));},80000);})]);}
 catch(e){if(e instanceof InputError)throw e;throw new InputError('The scan could not complete. Try a clearer photo or another scan language.',503);}
 finally{clearTimeout(timer);if(worker)await worker.terminate().catch(()=>{});busy=false;}
}
