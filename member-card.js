import {ObjectId} from 'mongodb';
export function memberCardHandler({getDB,isStaff}){
 return async(req,res)=>{
  res.set('Cache-Control','private, no-store');
  if(isStaff(req.user)||!ObjectId.isValid(req.user.id))return res.sendStatus(403);
  try{
   const db=getDB(),member=await db.collection('members').findOne({_id:new ObjectId(req.user.id)});
   if(!member)return res.sendStatus(404);
   const registration=ObjectId.isValid(member.registrationId||'')?await db.collection('prefills').findOne({_id:new ObjectId(member.registrationId),status:'active',memberNumber:member.memberNumber},{projection:{dob:1,documentNumber:1,signedAt:1}}):null;
   const end=member.membershipEndDate?new Date(member.membershipEndDate):null;
   const validDate=end&&!Number.isNaN(end.getTime());
   res.json({name:member.name||'',memberNumber:member.memberNumber??(/^\d+$/.test(String(member.email))?member.email:null),dob:registration?.dob||null,documentNumber:registration?.documentNumber||null,issuedAt:registration?.signedAt||member.createdAt||null,validUntil:validDate?end.toISOString():null,status:validDate?(end.getTime()<Date.now()?'expired':'active'):'unconfirmed'});
  }catch{res.status(503).json({error:'Card unavailable. Please try again.'});}
 };
}
