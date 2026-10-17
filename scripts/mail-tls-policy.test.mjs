import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMailTlsOptions } from '../electron/utils/mailTlsPolicy.mjs';
test('Mailcow 与公共邮箱都要求校验证书，旧渲染端不能恢复证书豁免',()=>{
 assert.throws(()=>resolveMailTlsOptions({host:'mail.outlook.top',verifyCertificate:false}));
 assert.deepEqual(resolveMailTlsOptions({host:'mail.outlook.top'}),{rejectUnauthorized:true});
 assert.deepEqual(resolveMailTlsOptions({host:'mail.outlook.top',verifyCertificate:true}),{rejectUnauthorized:true});
 assert.deepEqual(resolveMailTlsOptions({host:'imap.gmail.com'}),{rejectUnauthorized:true});
 assert.throws(()=>resolveMailTlsOptions({host:'imap.gmail.com',verifyCertificate:false}));
 assert.throws(()=>resolveMailTlsOptions({host:'mail.outlook.top.evil.invalid',verifyCertificate:false}));
 assert.throws(()=>resolveMailTlsOptions({host:'mail.outlook.top',verifyCertificate:'false'}));
});
