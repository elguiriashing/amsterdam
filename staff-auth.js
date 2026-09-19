import jwt from 'jsonwebtoken';
export const isStaff=user=>user?.id==='admin'||['super_admin','owner','staff_admin'].includes(user?.role);
export function createAuthenticate({secret,getDB}){
 return async(req,res,next)=>{
  res.set('Cache-Control','private, no-store');
  const match=/^Bearer ([^\s]+)$/.exec(req.headers.authorization||'');if(!match)return res.sendStatus(401);
  let user;try{user=jwt.verify(match[1],secret,{algorithms:['HS256']});}catch{return res.sendStatus(401);}
  if(!user||typeof user!=='object'||typeof user.id!=='string')return res.sendStatus(401);
  if(user.id!=='admin'&&isStaff(user)){
   try{const {ObjectId}=await import('mongodb');if(!ObjectId.isValid(user.id))return res.sendStatus(401);const admin=await getDB().collection('admins').findOne({_id:new ObjectId(user.id)});if(!admin||!isStaff({role:admin.role}))return res.sendStatus(401);user.role=admin.role;}catch{return res.sendStatus(503);}
  }
  req.user=user;next();
 };
}
