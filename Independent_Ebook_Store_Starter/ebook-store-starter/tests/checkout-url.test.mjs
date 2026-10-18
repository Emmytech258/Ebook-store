import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkoutTarget} from '../src/payments.js';

test('Hosted checkout validation allows the official sandbox only for test payments',()=>{
 const live='https://checkout.flutterwave.com/v3/hosted/pay/flwlnk-01hynrt7cd1fpm6gtef6khn93g';
 const sandbox='https://checkout-v2.dev-flutterwave.com/v3/hosted/pay/test-link';
 assert.equal(checkoutTarget(live,'live').href,live);
 assert.equal(checkoutTarget(live,'test').href,live);
 assert.equal(checkoutTarget(sandbox,'test').href,sandbox);
 assert.equal(checkoutTarget(sandbox,'live'),null);
 for(const link of [null,{},'not-a-url','http://checkout.flutterwave.com/v3/hosted/pay/test','https://checkout.flutterwave.com.evil.example/v3/hosted/pay/test','https://checkout-v2.dev-flutterwave.com.evil.example/v3/hosted/pay/test','https://checkout.flutterwave.com@evil.example/v3/hosted/pay/test','https://user:secret@checkout.flutterwave.com/v3/hosted/pay/test','https://checkout.flutterwave.com:8443/v3/hosted/pay/test','https://checkout.flutterwave.com/other','https://checkout.flutterwave.com/v3/hosted/pay/','https://checkout.flutterwave.com/v3/hosted/pay/test#redirect'])assert.equal(checkoutTarget(link,'test'),null,String(link));
});
