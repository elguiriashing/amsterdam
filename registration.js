import { prefillNotification } from './registration-notification.js';
import express from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import { ObjectId } from 'mongodb';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { InputError, details, numberValue, text, digest, identityKey, ocrSuggestions } from './registration-domain.js';

const days=n=>n*86400000;
const ready=()=>!!(process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);
let s3;
function storage() { if(!ready()) throw new InputError('Private ID storage is not configured. Bring the original ID to the club.',503); return s3 ||= new S3Client({region:'auto',endpoint:process.env.R2_ENDPOINT,credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}}); }
async function put(key,body,type) { await storage().send(new PutObjectCommand({Bucket:process.env.R2_BUCKET,Key:key,Body:body,ContentType:type,CacheControl:'private, no-store'})); }
async function get(key) { const r=await storage().send(new GetObjectCommand({Bucket:process.env.R2_BUCKET,Key:key}));return Buffer.from(await r.Body.transformToByteArray()); }
async function remove(key) { if(key) await storage().send(new DeleteObjectCommand({Bucket:process.env.R2_BUCKET,Key:key})); }
function oid(id) { if(!/^[a-f\d]{24}$/i.test(id)) throw new InputError('Invalid registration.',404);return new ObjectId(id); }
function safe(p) { if(!p)return p; const {uploadTokenHash,submissionKey,identityHash,idKey, ...rest}=p;return {...rest,hasId:!!idKey}; }

export async function setupRegistration(db) {
  await db.collection('prefills').createIndex({submissionKey:1},{unique:true,partialFilterExpression:{submissionKey:{$type:'string'}}});
  await db.collection('members').createIndex({registrationId:1},{unique:true,partialFilterExpression:{registrationId:{$type:'string'}}});
  await db.collection('members').createIndex({memberNumber:1},{unique:true,partialFilterExpression:{memberNumber:{$type:'number'}}});
  await db.collection('members').createIndex({identityHash:1},{unique:true,partialFilterExpression:{identityHash:{$type:'string'}}});
}
export function registrationRouter({getDB,client,authenticateToken,isAdmin,prefillLimiter,logAudit,notify,storeId=put}) {
 const router=express.Router();
 const run=fn=>(req,res,next)=>Promise.resolve().then(()=>{if(!getDB())throw new InputError('Database temporarily unavailable.',503);return fn(req,res);}).catch(next);
 const staff=[authenticateToken,(req,res,next)=>isAdmin(req)?next():res.status(403).json({error:'Staff access required.'})];
 const owner=(req,res,next)=>(req.user.id==='admin'||['owner','super_admin'].includes(req.user.role))?next():res.status(403).json({error:'Owner access required.'});
 router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');res.set('Pragma','no-cache');next();});
 async function transaction(fn) { const session=client.startSession();try {return await session.withTransaction(()=>fn(session));}finally{await session.endSession();} }
 async function allocate(db,session,kind,ref,requested) {
   const seq=await db.collection('registration_settings').findOne({_id:'numbers'},{session});
   if(!seq)throw new InputError('An owner must set the next unused number first, including all paper registrations.',409);
   let n;
   if(requested!==undefined && requested!=='') { n=numberValue(requested); if(n<seq.next)throw new InputError('That number is below the next unused number. Use an existing paper reservation.',409);await db.collection('registration_settings').updateOne({_id:'numbers'},{$set:{next:n+1}},{session}); }
   else {const old=await db.collection('registration_settings').findOneAndUpdate({_id:'numbers'},{$inc:{next:1}},{session,returnDocument:'before'});n=numberValue(old.next);}
   if(await db.collection('members').findOne({$or:[{memberNumber:n},{email:String(n)},{email:n}]},{session}))throw new InputError('Number already belongs to an existing member.',409);
   await db.collection('member_numbers').insertOne({_id:n,kind,ref,createdAt:new Date()},{session});return n;
 }
 router.get('/config',run(async(req,res)=>res.json({version:2,idUploads:ready(),ocr:ready()&&process.env.ID_OCR_ENABLED==='true',pendingDays:30,idRetentionDays:7})));
 router.post('/prefill',prefillLimiter,run(async(req,res)=>{
   if(req.body.ageConfirmed!==true||req.body.privacyAccepted!==true)throw new InputError('Confirm your age and read the privacy notice.');
   const d=details(req.body);const key=text(req.body.submissionKey,80);
   if(!/^[a-f\d-]{36}$/i.test(key))throw new InputError('Reload the form and try again.');
   const db=getDB();const token=crypto.randomBytes(32).toString('hex');const now=new Date();
   let p;
   try{p=await db.collection('prefills').findOneAndUpdate({submissionKey:key},{$setOnInsert:{...d,submissionKey:key,status:'pending',ts:now,expiresAt:new Date(+now+days(30)),privacyVersion:'2026-09-19',uploadTokenHash:digest(token),uploadExpiresAt:new Date(+now+1800000)}},{upsert:true,returnDocument:'after'});}catch(e){if(e.code!==11000)throw e;p=await db.collection('prefills').findOne({submissionKey:key});}
   // A repeat submission does not issue a new capability for an existing record.
   const created=p.uploadTokenHash===digest(token);
   if(created) {
     const total=await db.collection('prefills').countDocuments({});
     await notify(prefillNotification(p,total));
   }
   res.status(created?201:200).json({id:String(p._id),reference:String(p._id).slice(-8).toUpperCase(),uploadToken:created?token:undefined,alreadyReceived:!created});
 }));
 router.post('/walk-in',...staff,run(async(req,res)=>{
   const d=details(req.body), key=text(req.body.submissionKey,80);if(!/^[a-f\d-]{36}$/i.test(key))throw new InputError('Missing request reference.');
   const p=await getDB().collection('prefills').findOneAndUpdate({submissionKey:key},{$setOnInsert:{...d,submissionKey:key,status:'pending',source:'staff',ts:new Date(),expiresAt:new Date(Date.now()+days(30)),privacyVersion:'2026-09-19'}},{upsert:true,returnDocument:'after'});
   res.json(safe(p));
 }));
 const imageBody=express.raw({type:['image/jpeg','image/png','image/webp'],limit:'8mb'});
 router.put('/prefills/:id/id-image',prefillLimiter,imageBody,run(async(req,res)=>{
   const db=getDB(),id=oid(req.params.id),token=text(req.headers['x-upload-token'],100);
   const p=await db.collection('prefills').findOne({_id:id,uploadTokenHash:digest(token),uploadExpiresAt:{$gt:new Date()},status:'pending'});
   if(!token||!p)throw new InputError('Upload link expired. Staff can add your ID when you arrive.',403);
   await upload(req,res,p);
 }));
 async function upload(req,res,p,staffUpload=false) {
   if(!Buffer.isBuffer(req.body)||!req.body.length)throw new InputError('Choose a JPEG, PNG or WebP photo.');
   let image;try {image=await sharp(req.body,{limitInputPixels:40000000}).rotate().resize({width:1800,height:1800,fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer();}catch{throw new InputError('Photo could not be read. Try a smaller JPEG or PNG.');}
   const db=getDB();const lock=crypto.randomUUID();
   const acquired=await db.collection('prefills').updateOne({_id:p._id,status:{$in:staffUpload?['pending','prepared','active',null]:['pending','prepared',null]},$or:[{imageLock:{$exists:false}},{imageLockUntil:{$lt:new Date()}}]},{$set:{imageLock:lock,imageLockUntil:new Date(Date.now()+120000)}});
   if(!acquired.modifiedCount)throw new InputError('Another ID update is running. Try again shortly.',409);
   const key=`registration-ids/${p._id}.jpg`;
   try {const uploadedAt=new Date();await storeId(key,image,'image/jpeg');await db.collection('prefills').updateOne({_id:p._id,imageLock:lock},{$set:{idKey:key,idUploadedAt:uploadedAt,...(p.status==='active'?{idDeleteAt:new Date(+uploadedAt+days(7))}:{reviewed:false})},$unset:{imageLock:'',imageLockUntil:''}});if(staffUpload)await logAudit('registration_id_upload',String(p._id),req);res.json({success:true});}
   catch(e){await db.collection('prefills').updateOne({_id:p._id,imageLock:lock},{$unset:{imageLock:'',imageLockUntil:''}});throw e;}
 }
 router.put('/staff/prefills/:id/id-image',...staff,imageBody,run(async(req,res)=>{
   const p=await getDB().collection('prefills').findOne({_id:oid(req.params.id)});if(!p)throw new InputError('Registration not found.',404);await upload(req,res,p,true);
 }));
 router.get('/prefills',...staff,run(async(req,res)=>{
   const q=text(req.query.q,100),filter={};
   if(req.query.status && ['pending','prepared','active'].includes(req.query.status))filter.status=req.query.status==='pending'?{$in:['pending',null]}:req.query.status;
   if(q){const regex=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');filter.$or=['fullname','email','phone'].map(k=>({[k]:{$regex:regex,$options:'i'}}));if(/^\d+$/.test(q))filter.$or.push({memberNumber:Number(q)});}
   const offset=Math.max(0,Math.min(100000,Number(req.query.offset)||0));
   const items=await getDB().collection('prefills').find(filter).sort({ts:-1}).skip(offset).limit(50).toArray();res.json(items.map(safe));
 }));
 router.get('/prefills/:id',...staff,run(async(req,res)=>{const p=await getDB().collection('prefills').findOne({_id:oid(req.params.id)});if(!p)throw new InputError('Not found.',404);res.json(safe(p));}));
 router.patch('/prefills/:id',...staff,run(async(req,res)=>{
   const d=details(req.body);const result=await getDB().collection('prefills').findOneAndUpdate({_id:oid(req.params.id),status:{$in:['pending','prepared',null]}},{$set:{...d,updatedAt:new Date(),reviewed:false}},{returnDocument:'after'});
   if(!result)throw new InputError('Active registrations cannot be edited here.',409);await logAudit('registration_edit',req.params.id,req);res.json(safe(result));
 }));
 router.get('/prefills/:id/id-image',...staff,run(async(req,res)=>{const p=await getDB().collection('prefills').findOne({_id:oid(req.params.id)});if(!p?.idKey)throw new InputError('No ID image.',404);const b=await get(p.idKey);await logAudit('registration_id_view',req.params.id,req);res.type('jpeg').send(b);}));
 router.delete('/prefills/:id/id-image',...staff,run(async(req,res)=>{await deleteRegistrationData(getDB(),oid(req.params.id),false);await logAudit('registration_id_delete',req.params.id,req);res.json({success:true});}));
 router.delete('/prefills/:id',...staff,run(async(req,res)=>{await deleteRegistrationData(getDB(),oid(req.params.id),true);await logAudit('registration_delete',req.params.id,req);res.json({success:true});}));
 router.get('/numbers',...staff,run(async(req,res)=>{const db=getDB();res.json({settings:await db.collection('registration_settings').findOne({_id:'numbers'}),recent:await db.collection('member_numbers').find({}).sort({_id:-1}).limit(30).toArray()});}));
 router.post('/numbers/setup',...staff,owner,run(async(req,res)=>{
   if(req.body.paperChecked!==true)throw new InputError('Check the last paper membership number first.');const next=numberValue(req.body.next),db=getDB();
   await transaction(async session=>{
     const old=await db.collection('registration_settings').findOne({_id:'numbers'},{session});if(old&&next<old.next)throw new InputError('The counter cannot move backwards.');
     const members=await db.collection('members').find({}, {session,projection:{email:1,memberNumber:1}}).toArray();
     const max=members.reduce((max,m)=>Math.max(max,Number(m.memberNumber)||0,/^\d+$/.test(String(m.email))?Number(m.email):0),0);
     if(next<=max)throw new InputError(`Next number must be above existing member ${max}.`);
     await db.collection('registration_settings').updateOne({_id:'numbers'},{$set:{next,updatedAt:new Date()}},{upsert:true,session});
   });await logAudit('registration_number_setup',String(next),req);res.json({next});
 }));
 router.post('/numbers/reserve',...staff,run(async(req,res)=>{
   const key=text(req.body.requestId,80);if(!/^[a-f\d-]{36}$/i.test(key))throw new InputError('Missing reservation reference.');const db=getDB();
   const n=await transaction(async session=>{const existing=await db.collection('registration_requests').findOne({_id:key},{session});if(existing)return existing.number;const number=await allocate(db,session,'paper',key,req.body.number);await db.collection('registration_requests').insertOne({_id:key,number},{session});return number;});
   await logAudit('registration_paper_reserve',String(n),req);res.json({number:n});
 }));
 router.post('/prefills/:id/prepare',...staff,run(async(req,res)=>{
   if(req.body.identityChecked!==true||req.body.addressChecked!==true)throw new InputError('Check the original ID and Spanish accommodation address.');const db=getDB(),id=oid(req.params.id);
   const p=await transaction(async session=>{
     const p=await db.collection('prefills').findOne({_id:id},{session});if(!p)throw new InputError('Not found.',404);if(p.imageLock)throw new InputError('Wait for the ID upload to finish.',409);if(p.memberNumber)return p;
     details(p);if(!p.documentNumber)throw new InputError('Record the ID/passport number before assigning membership.');let number;
     if(req.body.paperNumber) {number=numberValue(req.body.paperNumber);const r=await db.collection('member_numbers').updateOne({_id:number,kind:'paper'},{$set:{kind:'registration',ref:String(id)}},{session});if(!r.modifiedCount)throw new InputError('Paper reservation not available.',409);}
     else number=await allocate(db,session,'registration',String(id));
     await db.collection('prefills').updateOne({_id:id},{$set:{memberNumber:number,status:'prepared',reviewed:true,reviewedAt:new Date(),reviewedBy:String(req.user.id)}},{session});return {...p,memberNumber:number,status:'prepared',reviewed:true};
   });await logAudit('registration_prepare',String(id),req);res.json(safe(p));
 }));
 router.post('/prefills/:id/activate',...staff,run(async(req,res)=>{
   if(req.body.signed!==true)throw new InputError('Confirm the official paper form was signed.');const db=getDB(),id=oid(req.params.id),password=crypto.randomBytes(12).toString('base64url'),hash=await bcrypt.hash(password,12);
   const result=await transaction(async session=>{
     const p=await db.collection('prefills').findOne({_id:id},{session});if(!p?.memberNumber)throw new InputError('Prepare and assign a number first.',409);
     if(p.status==='active')return {alreadyActive:true,memberNumber:p.memberNumber};
     if(p.imageLock)throw new InputError('Wait for the ID upload to finish.',409);
     if(!p.reviewed)throw new InputError('Details changed: verify the ID/address again using Prepare.',409);details(p);
     const identityHash=identityKey(p.documentNumber);
     if(identityHash&&await db.collection('members').findOne({identityHash},{session}))throw new InputError('This ID already belongs to a member. Review the existing membership.',409);
     const end=new Date();end.setFullYear(end.getFullYear()+1);
     const member={name:p.fullname,email:String(p.memberNumber),contactEmail:p.email,phone:p.phone,memberNumber:p.memberNumber,registrationId:String(id),password:hash,createdAt:new Date(),membershipEndDate:end,balance:0,tier:'normal',discount:0,activityLog:[]};if(identityHash)member.identityHash=identityHash;
     await db.collection('members').insertOne(member,{session});await db.collection('prefills').updateOne({_id:id},{$set:{status:'active',signedAt:new Date(),activatedAt:new Date(),idDeleteAt:new Date(Date.now()+days(7))},$unset:{uploadTokenHash:'',uploadExpiresAt:'',expiresAt:''}},{session});return {memberNumber:p.memberNumber,password};
   });await logAudit('registration_activate',String(id),req);res.json(result);
 }));
 router.post('/prefills/:id/review',...staff,run(async(req,res)=>{if(req.body.identityChecked!==true||req.body.addressChecked!==true)throw new InputError('Verify the ID and address.');await getDB().collection('prefills').updateOne({_id:oid(req.params.id),status:'prepared'},{$set:{reviewed:true,reviewedAt:new Date()}});res.json({success:true});}));
 router.post('/prefills/:id/reset-login',...staff,run(async(req,res)=>{
   const password=crypto.randomBytes(12).toString('base64url');const r=await getDB().collection('members').findOneAndUpdate({registrationId:req.params.id},{$set:{password:await bcrypt.hash(password,12)}},{returnDocument:'after'});if(!r)throw new InputError('Active member not found.',404);await logAudit('registration_reset_login',req.params.id,req);res.json({memberNumber:r.memberNumber,password});
 }));
 let ocrBusy=false;
 router.post('/prefills/:id/ocr',...staff,run(async(req,res)=>{
   if(process.env.ID_OCR_ENABLED!=='true')throw new InputError('ID text extraction is not enabled. Staff can enter the details manually.',503);
   if(ocrBusy)throw new InputError('Another ID scan is running. Try again shortly.',429);ocrBusy=true;let worker;
   try{const p=await getDB().collection('prefills').findOne({_id:oid(req.params.id)});if(!p?.idKey)throw new InputError('Upload an ID first.');const bytes=await get(p.idKey);const {createWorker}=await import('tesseract.js');worker=await createWorker('eng',1,{logger:()=>{}});const result=await Promise.race([worker.recognize(bytes),new Promise((_,reject)=>{const t=setTimeout(()=>reject(new InputError('Scan timed out. Enter details manually.',503)),45000);t.unref();})]);await logAudit('registration_ocr',req.params.id,req);res.json({text:result.data.text.slice(0,6000),suggestions:ocrSuggestions(result.data.text),notice:'Text extraction only. Check every field against the original document.'});}finally{if(worker)await worker.terminate();ocrBusy=false;}
 }));
 // Official legal text is supplied by the club, never generated by the app.
 router.get('/template',...staff,run(async(req,res)=>{const t=await getDB().collection('registration_settings').findOne({_id:'template'});res.json({ready:!!t,layout:t?.layout||{},version:t?.version,approved:t?.approved===true});}));
 router.put('/template',...staff,owner,express.raw({type:'application/pdf',limit:'10mb'}),run(async(req,res)=>{
   if(!Buffer.isBuffer(req.body))throw new InputError('Upload a PDF.');const pdf=await PDFDocument.load(req.body);if(pdf.getPageCount()!==2)throw new InputError('The official template must have exactly two pages.');
   await put('registration-template/current.pdf',req.body,'application/pdf');await getDB().collection('registration_settings').updateOne({_id:'template'},{$set:{version:new Date().toISOString(),layout:{},approved:false}},{upsert:true});await logAudit('registration_template_upload','two-page PDF',req);res.json({success:true});
 }));
 router.put('/template/layout',...staff,owner,run(async(req,res)=>{
   const allowed=['firstName','surname','fullname','dob','address','email','phone','memberNumber','documentNumber','date','idImage'];const layout={};
   for(const [k,v]of Object.entries(req.body.layout||{})){if(!allowed.includes(k)||![0,1].includes(v.page)||!Number.isFinite(v.x)||!Number.isFinite(v.y)||v.x<0||v.y<0||v.x>1000||v.y>1500)throw new InputError('Invalid template coordinates.');layout[k]={page:v.page,x:v.x,y:v.y,size:Math.min(18,Math.max(6,Number(v.size)||10)),width:Math.min(500,Math.max(30,Number(v.width)||180)),height:Math.min(500,Math.max(30,Number(v.height)||110))};}
   if(!layout.memberNumber||!layout.fullname&&!layout.firstName)throw new InputError('Map at least member number and name.');
   const result=await getDB().collection('registration_settings').updateOne({_id:'template'},{$set:{layout,approved:req.body.approved===true}});if(!result.matchedCount)throw new InputError('Upload the official template first.');res.json({success:true});
 }));
 router.get('/prefills/:id/form.pdf',...staff,run(async(req,res)=>{
   const db=getDB(),p=await db.collection('prefills').findOne({_id:oid(req.params.id)});if(!p?.memberNumber)throw new InputError('Assign a member number first.');const t=await db.collection('registration_settings').findOne({_id:'template'});if(!t || (!t.approved && req.query.preview!=='1'))throw new InputError('Official form not configured. Use the draft intake sheet and existing paper form.',409);
   const pdf=await PDFDocument.load(await get('registration-template/current.pdf'));const font=await pdf.embedFont(StandardFonts.Helvetica);
   const values={...p,address:[p.address?.line,p.address?.postcode,p.address?.city,'Spain'].join(', '),date:new Date().toLocaleDateString('en-GB')};
   for(const [key,c]of Object.entries(t.layout)){const page=pdf.getPage(c.page);if(key==='idImage'){if(p.idKey){const image=await pdf.embedJpg(await get(p.idKey));const fit=image.scaleToFit(c.width,c.height);page.drawImage(image,{x:c.x,y:c.y,...fit});}}else {const str=String(values[key]||'');try{font.encodeText(str);}catch{throw new InputError('A name contains characters unsupported by this template font. Use the browser draft or update the template font.');}const width=font.widthOfTextAtSize(str,c.size);const size=width>c.width?c.size*c.width/width:c.size;if(size<6)throw new InputError(`The ${key} field will not fit. Adjust the template before printing.`);page.drawText(str,{x:c.x,y:c.y,size,font,color:rgb(0,0,0)});}}
   if(req.query.preview==='1')for(const page of pdf.getPages())page.drawText('DRAFT - CHECK TEMPLATE PLACEMENT',{x:25,y:20,size:12,font,color:rgb(0.8,0,0)});
   await logAudit('registration_print',`${p._id} template:${t.version}`,req);res.type('pdf').set('Content-Disposition',`inline; filename="membership-${p.memberNumber}.pdf"`).send(Buffer.from(await pdf.save()));
 }));
 router.use((err,req,res,next)=>{if(res.headersSent)return next(err);res.status(err.status|| (err.code===11000?409:500)).json({error:err instanceof InputError?err.message:err.code===11000?'This number or ID is already registered. Reload and review.':'Request failed. Please retry; if it persists contact the club.'});});
 return router;
}
// A shared database lock keeps upload, deletion and activation from racing.
export async function deleteRegistrationData(db,id,wholeRecord=false,allowActive=false,retentionOnly=false) {
 const lock=crypto.randomUUID();
 const p=await db.collection('prefills').findOneAndUpdate({_id:id,...(retentionOnly?{$and:[{$or:[{expiresAt:{$lt:new Date()}},{idDeleteAt:{$lt:new Date()},idKey:{$exists:true}}]}]}:{}),...(wholeRecord&&!allowActive?{status:{$ne:'active'}}:{}),$or:[{imageLock:{$exists:false}},{imageLockUntil:{$lt:new Date()}}]},{$set:{imageLock:lock,imageLockUntil:new Date(Date.now()+120000)}},{returnDocument:'after'});
 if(!p){if(await db.collection('prefills').findOne({_id:id}))throw new InputError('Registration is active or another ID operation is running. Try again shortly.',409);return;}
 try {
   if(p.idKey)await remove(p.idKey);
   if(wholeRecord)await db.collection('prefills').deleteOne({_id:id,imageLock:lock});
   else await db.collection('prefills').updateOne({_id:id,imageLock:lock},{$unset:{idKey:'',idDeleteAt:''}});
 } finally {await db.collection('prefills').updateOne({_id:id,imageLock:lock},{$unset:{imageLock:'',imageLockUntil:''}});}
}
export function startRegistrationCleanup(getDB) {
 let running=false;
 const clean=async()=>{if(running||!getDB())return;running=true;try{const db=getDB();const rows=await db.collection('prefills').find({$or:[{expiresAt:{$lt:new Date()}},{idDeleteAt:{$lt:new Date()},idKey:{$exists:true}}]}).limit(100).toArray();for(const p of rows){try{await deleteRegistrationData(db,p._id,p.status!=='active',false,true);}catch{console.error('Registration retention cleanup failed; will retry.');}}}finally{running=false;}};
 const timer=setInterval(()=>clean().catch(()=>console.error('Registration cleanup unavailable.')),3600000);timer.unref();return clean;
}
