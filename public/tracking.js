(function(){
  let pixel='',mode='setup',privatePage=false,frame=null,nonce='',serverEnabled=false,started=false;
  let country='',reviewing=false;
  // Visitors in these places are asked first. Everyone else is measured by default and can switch it off.
  const askFirst=new Set('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH'.split(' '));
  const optIn=()=>!/^[A-Z]{2}$/.test(country)||country==='OT'||country==='XX'||askFirst.has(country);
  const consentKey='bs-tracking-consent';
  const choice=()=>{try{return window.localStorage.getItem(consentKey);}catch{return null;}};
  const allowed=()=>{const saved=choice();return saved==='yes'||(saved===null&&!optIn());};
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
      pixel=/^\d{5,30}$/.test(String(id))?String(id):'';mode=paymentMode;privatePage=page==='download';nonce=options.nonce||'';serverEnabled=Boolean(options.conversions_api_enabled);country=String(options.country||'');
      if(!pixel||mode!=='live'||privatePage)return;
      if(allowed())this.start();
    },
    start(){
      if(started||!pixel||mode!=='live'||privatePage||!allowed())return;
      started=true;attributionCookies();this.track('PageView',{});
    },
    // Visitors who must be asked say yes first. Elsewhere tracking is on until the visitor turns it off.
    available(){return Boolean(pixel)&&mode==='live'&&!privatePage;},
    needsChoice(){return this.available()&&(reviewing||(choice()===null&&optIn()));},
    optIn(){return optIn();},
    defaultOn(){return this.available()&&!optIn();},
    consented(){return allowed();},
    setConsent(yes){try{window.localStorage.setItem(consentKey,yes?'yes':'no');}catch{return false;}reviewing=false;if(yes)this.start();return true;},
    resetChoice(){if(!optIn()){reviewing=true;return;}try{window.localStorage.removeItem(consentKey);}catch{}},
    track(event,data,eventId){
      if(!pixel||mode!=='live'||!allowed())return;
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
