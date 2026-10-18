(function(){
  let pixel='',mode='setup',privatePage=false,frame=null,nonce='',serverEnabled=false;
  const uid=()=>window.crypto?.randomUUID?.()||'event-'+Date.now()+'-'+Math.random().toString(36).slice(2);
  const cookie=name=>document.cookie.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)||'';
  function context(){return {fbp:cookie('_fbp'),fbc:cookie('_fbc')};}
  function attributionCookies(){
    if(!serverEnabled||privatePage)return;
    const suffix='; Max-Age=7776000; Path=/; SameSite=Lax; Secure';
    if(!cookie('_fbp'))document.cookie='_fbp=fb.1.'+Date.now()+'.'+Math.floor(Math.random()*1e10)+suffix;
    const click=new URLSearchParams(location.search).get('fbclid');
    if(click&&/^[A-Za-z0-9_-]{1,300}$/.test(click))document.cookie='_fbc=fb.1.'+Date.now()+'.'+click+suffix;
  }
  const load=()=>{
    if(window.fbq)return;
    const fbq=function(){fbq.callMethod?fbq.callMethod.apply(fbq,arguments):fbq.queue.push(arguments);};
    fbq.push=fbq;fbq.loaded=true;fbq.version='2.0';fbq.queue=[];window.fbq=fbq;
    const script=document.createElement('script');script.async=true;script.src='https://connect.facebook.net/en_US/fbevents.js';document.head.append(script);
    fbq('init',pixel);
  };
  window.BSTracking={
    init(id,paymentMode,page,options={}){
      pixel=/^\d{5,30}$/.test(String(id))?String(id):'';mode=paymentMode;privatePage=page==='download';nonce=options.nonce||'';serverEnabled=Boolean(options.conversions_api_enabled);
      if(!pixel||mode!=='live'||privatePage)return;
      attributionCookies();this.track('PageView',{});
    },
    track(event,data,eventId){
      if(!pixel||mode!=='live')return;
      eventId=eventId||uid();
      if(privatePage){
        if(event!=='Purchase')return;
        if(!frame){frame=document.createElement('iframe');frame.hidden=true;frame.title='Purchase tracking';frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';frame.src='/books/pixel-frame.html?pixel='+encodeURIComponent(pixel);document.body.append(frame);}
        // The sandbox has an opaque origin. Only public purchase totals and IDs cross this boundary.
        const purchase={value:data?.value,currency:data?.currency,content_ids:data?.content_ids,content_type:'product'};
        const send=()=>frame.contentWindow?.postMessage({event,data:purchase,eventId},'*');
        if(frame.dataset.ready)send();else frame.addEventListener('load',()=>{frame.dataset.ready='1';send();},{once:true});
      }else{
        load();window.fbq('track',event,data,{eventID:eventId});
        if(serverEnabled&&nonce&&event!=='Purchase')fetch('/books/api/events',{method:'POST',credentials:'same-origin',keepalive:true,headers:{'Content-Type':'application/json','X-BS-Nonce':nonce},body:JSON.stringify({event,event_id:eventId,path:location.pathname,data:data||{},context:context()})}).catch(()=>{});
      }
    },context
  };
})();
