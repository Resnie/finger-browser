import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserRuntimeLeaseTokens} from '../electron/main/models/browserRuntimeLeaseTokens.mjs';
import {BrowserRuntimeLeases} from '../electron/main/models/browserRuntimeLease.mjs';
const token='a'.repeat(64);
function fixture(){
 const values=new Map();let available=true;
 class Store {get(k){return values.get(k)}set(k,v){values.set(k,v)}delete(k){values.delete(k)}}
 const crypto={isEncryptionAvailable:()=>available,encryptString:s=>Buffer.from('test-encrypted:'+s.split('').reverse().join('')),decryptString:b=>b.toString().slice(15).split('').reverse().join('')};
 const options={StoreClass:Store,safeStorageAdapter:crypto};
 return {values,options,off:()=>available=false};
}
test('running ownership survives application restart as an encrypted owner-scoped token',async()=>{
 const f=fixture();const store=new BrowserRuntimeLeaseTokens(f.options);store.save(1,'test-browser',token);
 const raw=[...f.values.values()][0];assert.ok(raw.startsWith('v1:'));assert.ok(!raw.includes(token));
 const restarted=new BrowserRuntimeLeaseTokens(f.options);assert.equal(restarted.load(1,'test-browser'),token);assert.equal(restarted.load(2,'test-browser'),'');
 const leases=new BrowserRuntimeLeases({tokenStore:restarted,request:async(_action,payload)=>{assert.equal(payload.token,token);return {ttlMillis:90000,recovery:{recoveryRevision:3}}},onLost:async()=>{}});
 await leases.acquire('test-browser',1);await assert.rejects(leases.acquire('test-browser',2),/其他登录用户/);await leases.release('test-browser',3);assert.equal(restarted.load(1,'test-browser'),'');
});
test('unavailable encryption blocks acquiring an unpersisted remote lock',async()=>{
 const f=fixture();f.off();let requests=0;
 const leases=new BrowserRuntimeLeases({tokenStore:new BrowserRuntimeLeaseTokens(f.options),request:async()=>requests++,onLost:async()=>{}});
 await assert.rejects(leases.acquire('test-browser',1),/安全存储/);assert.equal(requests,0);
});
test('a protocol/server rejection does not discard an encrypted original-holder credential',async()=>{
 const f=fixture();const store=new BrowserRuntimeLeaseTokens(f.options);store.save(1,'test-browser',token);
 const leases=new BrowserRuntimeLeases({tokenStore:store,request:async()=>{const e=new Error('test-server-unavailable');e.definitiveLeaseRejection=true;throw e},onLost:async()=>{}});
 await assert.rejects(leases.acquire('test-browser',1));assert.equal(store.load(1,'test-browser'),token);assert.equal(leases.getToken('test-browser'),'');
});
