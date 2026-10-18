const pixel=new URLSearchParams(location.search).get('pixel');
if(/^\d{5,30}$/.test(pixel||'')){
  const fbq=function(){fbq.callMethod?fbq.callMethod.apply(fbq,arguments):fbq.queue.push(arguments);};
  fbq.push=fbq;fbq.loaded=true;fbq.version='2.0';fbq.queue=[];window.fbq=fbq;fbq('init',pixel);
  const script=document.createElement('script');script.async=true;script.src='https://connect.facebook.net/en_US/fbevents.js';document.head.append(script);
  addEventListener('message',event=>{
    const message=event.data;
    if(event.origin!==location.origin||event.source!==parent||message?.event!=='Purchase'||typeof message.eventId!=='string')return;
    if(!Number.isFinite(message.data?.value)||!['NGN','GHS','KES','MWK','RWF','TZS','UGX','XAF','XOF','ZMW','USD'].includes(message.data.currency)||!Array.isArray(message.data.content_ids))return;
    fbq('track','Purchase',{value:message.data.value,currency:message.data.currency,content_ids:message.data.content_ids,content_type:'product'},{eventID:message.eventId});
  });
}
