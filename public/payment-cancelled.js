// Runs only inside the Bachs payment box after the buyer clicks Exit checkout.
// It tells the store page so the store can close the box. It carries no order details.
try{window.top.postMessage({source:'bs-payment-cancelled'},location.origin);}catch(error){}
