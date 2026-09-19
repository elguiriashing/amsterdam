import express from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import {ObjectId} from 'mongodb';
import * as webauthn from '@simplewebauthn/server';
export async function setupMemberAccount(db){
 await db.collection('member_passkeys').createIndex({credentialId:1},{unique:true});
 await db.collection('member_passkeys').createIndex({memberId:1});
 await db.collection('member_passkey_challenges').createIndex({expiresAt:1},{expireAfterSeconds:0});
}
export function memberAccountRouter({getDB,authenticateToken,isStaff,generateToken,authLimiter,config,wa=webauthn}){
 const router=express.Router(),wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
 const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
 const collection=name=>getDB().collection(name);
 const active=m=>m&&(!m.membershipEndDate||new Date(m.membershipEndDate)>=new Date());
 async function requireMember(req,res,next){try{if(isStaff(req.user)||!ObjectId.isValid(req.user.id))return res.sendStatus(403);const m=await collection('members').findOne({_id:new ObjectId(req.user.id)});if(!m)return res.sendStatus(401);req.member=m;next();}catch(e){next(e);}}
 const protectedRoute=[authenticateToken,requireMember];
 const passwordOK=async(m,p)=>typeof p==='string'&&Buffer.byteLength(p)<=72&&await bcrypt.compare(p,m.password);
 async function challenge(purpose,options,memberId=null,extra={}){const id=crypto.randomBytes(32).toString('base64url');await collection('member_passkey_challenges').insertOne({_id:id,purpose,challenge:options.challenge,memberId,expiresAt:new Date(Date.now()+300000),...extra});return {challengeId:id,options};}
 async function consume(req,purpose,memberId=null){const id=req.body.challengeId;if(typeof id!=='string')fail('Please start again.');const c=await collection('member_passkey_challenges').findOneAndDelete({_id:id,purpose,memberId,expiresAt:{$gt:new Date()}});if(!c)fail('Request expired or already used. Please start again.');return c;}
 router.use((req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
 router.get('/',...protectedRoute,wrap(async(req,res)=>{const m=req.member;res.json({name:m.name,memberNumber:m.memberNumber||m.email,contactEmail:m.contactEmail||'',phone:m.phone||''});}));
 router.patch('/',...protectedRoute,wrap(async(req,res)=>{
  const {contactEmail,phone}=req.body;if(typeof contactEmail!=='string'||contactEmail.length>254||(contactEmail&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail))||typeof phone!=='string'||phone.length>40||(phone&&!/^[+\d ()-]+$/.test(phone)))fail('Enter a valid email and phone number.');
  await collection('members').updateOne({_id:req.member._id},{$set:{contactEmail:contactEmail.trim(),phone:phone.trim()}});res.json({success:true});
 }));
 router.post('/password',authLimiter,...protectedRoute,wrap(async(req,res)=>{
  const {currentPassword,newPassword}=req.body;if(!await passwordOK(req.member,currentPassword))fail('Current password is incorrect.',403);
  if(typeof newPassword!=='string'||newPassword.length<12||Buffer.byteLength(newPassword)>72)fail('Use at least 12 characters, up to 72 bytes.');
  const result=await collection('members').updateOne({_id:req.member._id,password:req.member.password},{$set:{password:await bcrypt.hash(newPassword,12)}});if(!result.modifiedCount)fail('Account changed. Please try again.',409);res.json({success:true});
 }));
 router.get('/passkeys',...protectedRoute,wrap(async(req,res)=>{const keys=await collection('member_passkeys').find({memberId:String(req.member._id)},{projection:{name:1,createdAt:1,lastUsed:1}}).toArray();res.json({passkeys:keys});}));
 router.delete('/passkeys/:id',...protectedRoute,wrap(async(req,res)=>{if(!ObjectId.isValid(req.params.id))fail('Invalid passkey.');await collection('member_passkeys').deleteOne({_id:new ObjectId(req.params.id),memberId:String(req.member._id)});res.json({success:true});}));
 router.post('/passkeys/register-options',authLimiter,...protectedRoute,wrap(async(req,res)=>{
  const m=req.member;if(!active(m))fail('Membership expired. Please contact staff.',403);if(!await passwordOK(m,req.body.currentPassword))fail('Enter your current password to enable biometrics.',403);
  const keys=await collection('member_passkeys').find({memberId:String(m._id)}).toArray();if(keys.length>=10)fail('Remove an old passkey first (maximum 10).');
  const name=typeof req.body.name==='string'?req.body.name.trim().slice(0,60):'';if(!name)fail('Give this passkey a name.');
  const options=await wa.generateRegistrationOptions({rpName:config.rpName+' Members',rpID:config.rpID,userID:Buffer.from('member:'+m._id),userName:String(m.memberNumber||m.email),userDisplayName:m.name,attestationType:'none',excludeCredentials:keys.map(k=>({id:k.credentialId})),authenticatorSelection:{residentKey:'required',userVerification:'required'},timeout:60000});
  res.json(await challenge('register',options,String(m._id),{name,passwordProof:crypto.createHash("sha256").update(m.password).digest("hex")}));
 }));
 router.post('/passkeys/register',authLimiter,...protectedRoute,wrap(async(req,res)=>{
  const c=await consume(req,'register',String(req.member._id));if(c.passwordProof!==crypto.createHash("sha256").update(req.member.password).digest("hex"))fail('Password changed. Please start again.');
  let v;try{v=await wa.verifyRegistrationResponse({response:req.body.credential,expectedChallenge:c.challenge,expectedOrigin:config.origin,expectedRPID:config.rpID,requireUserVerification:true});}catch{fail('Passkey verification failed.');}
  if(!v.verified||!v.registrationInfo)fail('Passkey verification failed.');const info=v.registrationInfo;
  await collection('member_passkeys').insertOne({memberId:String(req.member._id),credentialId:info.credentialID,publicKey:Buffer.from(info.credentialPublicKey).toString('base64url'),counter:info.counter,name:c.name,createdAt:new Date(),lastUsed:null});res.json({success:true});
 }));
 router.post('/passkeys/login-options',authLimiter,wrap(async(req,res)=>{const options=await wa.generateAuthenticationOptions({rpID:config.rpID,userVerification:'required',timeout:60000});res.json(await challenge('login',options));}));
 router.post('/passkeys/login',authLimiter,wrap(async(req,res)=>{
  const c=await consume(req,'login');const credential=req.body.credential;if(typeof credential?.id!=='string')fail('Unable to sign in.',401);
  const key=await collection('member_passkeys').findOne({credentialId:credential.id});if(!key)fail('Unable to sign in. Use your password.',401);
  const m=await collection('members').findOne({_id:new ObjectId(key.memberId)});if(!active(m))fail('Membership unavailable or expired. Contact staff.',403);
  if(credential.response?.userHandle!==Buffer.from('member:'+m._id).toString('base64url'))fail('Unable to sign in.',401);
  let v;try{v=await wa.verifyAuthenticationResponse({response:credential,expectedChallenge:c.challenge,expectedOrigin:config.origin,expectedRPID:config.rpID,requireUserVerification:true,authenticator:{credentialID:key.credentialId,credentialPublicKey:new Uint8Array(Buffer.from(key.publicKey,'base64url')),counter:key.counter}});}catch{fail('Unable to verify passkey. Use your password.',401);}
  if(!v.verified)fail('Unable to sign in.',401);
  const updated=await collection('member_passkeys').updateOne({_id:key._id,counter:key.counter},{$set:{counter:v.authenticationInfo.newCounter,lastUsed:new Date()}});if(!updated.matchedCount)fail('Passkey changed. Please try again.',401);
  res.json({token:generateToken({_id:m._id,name:m.name,email:m.email}),user:{id:m._id,name:m.name,email:m.email,balance:m.balance||0}});
 }));
 router.use((err,req,res,next)=>res.status(err.status||400).json({error:err.status?err.message:'Request failed. Please try again.'}));return router;
}
