export const MOBILE_CURRENCIES=['GHS','KES','MWK','RWF','TZS','UGX','XAF','XOF','ZMW'];
export const SHOP_CURRENCIES=['NGN',...MOBILE_CURRENCIES];
export const ALL_CURRENCIES=[...SHOP_CURRENCIES,'USD'];
export const COUNTRY_CURRENCIES={NG:'NGN',GH:'GHS',KE:'KES',MW:'MWK',RW:'RWF',TZ:'TZS',UG:'UGX',ZM:'ZMW',CM:'XAF',CF:'XAF',CG:'XAF',GA:'XAF',GQ:'XAF',TD:'XAF',BJ:'XOF',BF:'XOF',CI:'XOF',GW:'XOF',ML:'XOF',NE:'XOF',SN:'XOF',TG:'XOF'};
export const currencyFor=country=>COUNTRY_CURRENCIES[country]||'USD';
export const paymentProvider=currency=>currency==='NGN'?'flutterwave':'bachs';
export const corridorFor=currency=>currency==='USD'?'USD_CARD':MOBILE_CURRENCIES.includes(currency)?'MOMO_'+currency:null;
export const currencyDecimals=currency=>['NGN','GHS','ZMW','USD'].includes(currency)?2:0;
export function configuredCurrencies(s){
  let values;try{values=JSON.parse(s.currencies||'[]');}catch{}
  return Array.isArray(values)?[...new Set(values.filter(c=>ALL_CURRENCIES.includes(c)))]:['NGN'];
}
export function providerReady(s,provider,mode=s.mode){
  if(!['test','live'].includes(mode))return false;
  return provider==='flutterwave'?Boolean(s[mode==='live'?'flutterwave_live':'flutterwave_test']&&s.webhook_secret):Boolean(s['bachs_'+mode]&&s['bachs_webhook_'+mode]);
}
export function activeCurrencies(s){
  const configured=configuredCurrencies(s);
  return configured.filter(c=>providerReady(s,paymentProvider(c)));
}
// Compare major-unit decimal strings as integer minor units. No float rounding can
// turn an underpayment into a full payment.
export function minorUnits(value){
  const text=typeof value==='number'&&Number.isFinite(value)?String(value):value;
  if(typeof text!=='string'||!/^\d{1,12}(?:\.\d{1,2})?$/.test(text))return null;
  const [whole,fraction='']=text.split('.');return BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
}
