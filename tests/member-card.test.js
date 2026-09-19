import test from 'node:test';import assert from 'node:assert/strict';import express from 'express';import request from 'supertest';import jwt from 'jsonwebtoken';import {ObjectId} from 'mongodb';
import {memberCardHandler} from '../member-card.js';import {createAuthenticate,isStaff} from '../staff-auth.js';
test('member card is private, token-scoped, and exposes only card fields',async()=>{
 const id=new ObjectId(),registrationId=new ObjectId();let query;
 const db={collection:name=>({findOne:async q=>{if(name==='members'){query=q;return {name:'Test Member',email:'15003',memberNumber:15003,registrationId:String(registrationId),password:'never-return',balance:99,membershipEndDate:'2099-01-01'};}assert.equal(String(q._id),String(registrationId));assert.equal(q.status,'active');return {dob:'1990-01-01',documentNumber:'TEST-ID',signedAt:'2026-01-01'};}})};
 const app=express();app.get('/card',createAuthenticate({secret:'test-secret',getDB:()=>db}),memberCardHandler({getDB:()=>db,isStaff}));
 assert.equal((await request(app).get('/card')).status,401);
 const auth=user=>'Bearer '+jwt.sign(user,'test-secret',{expiresIn:'1h'});
 assert.equal((await request(app).get('/card').set('Authorization',auth({id:'admin'}))).status,403);
 const r=await request(app).get('/card?id=someone-else').set('Authorization',auth({id:String(id)}));assert.equal(r.status,200);assert.equal(String(query._id),String(id));assert.equal(r.body.memberNumber,15003);assert.equal(r.body.status,'active');assert.equal(r.body.documentNumber,'TEST-ID');assert.equal(r.body.password,undefined);assert.equal(r.body.balance,undefined);assert.match(r.headers['cache-control'],/no-store/);
});
test('legacy cards do not invent missing identity or validity',async()=>{
 const app=express();app.use((req,res,next)=>{req.user={id:String(new ObjectId())};next();});app.get('/card',memberCardHandler({isStaff,getDB:()=>({collection:()=>({findOne:async()=>({name:'Legacy',email:'429'})})})}));
 const r=await request(app).get('/card');assert.equal(r.body.memberNumber,'429');assert.equal(r.body.status,'unconfirmed');assert.equal(r.body.dob,null);assert.equal(r.body.documentNumber,null);
});
