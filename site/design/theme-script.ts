// Runs in the document's head before the first paint: the saved choice of theme (the switch's localStorage key, the
// same as the old site's), so a dark choice never flashes light. It also marks the page as one that runs scripts
// (data-js): a control that needs a script (the theme switch, Copy) is shown only then, never as a dead button.
// A chosen theme also sets the media of each <picture>'s dark source (source[data-dark]) as the page is read: the
// observer's callback is a microtask queued when the <source> is added, before the <img> after it picks its file, so
// a chosen dark on a light system never paints, or fetches for the page, the light picture (ThemeSwitch does the
// same later, on a flip). A dark source for one width (data-width, the story's phone pictures) keeps that width.
// Allowed by its hash in the content security policy.
export const THEME_SCRIPT = "document.documentElement.dataset.js='1';try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;var m=t==='dark'?'all':'not all',f=function(e){if(e.nodeType!==1)return;if(e.matches('source[data-dark]'))e.media=m==='all'&&e.getAttribute('data-width')||m;var q=e.querySelectorAll('source[data-dark]');for(var k=0;k<q.length;k++)q[k].media=m==='all'&&q[k].getAttribute('data-width')||m},o=new MutationObserver(function(r){for(var i=0;i<r.length;i++)for(var j=0;j<r[i].addedNodes.length;j++)f(r[i].addedNodes[j])});o.observe(document,{childList:true,subtree:true});addEventListener('DOMContentLoaded',function(){o.disconnect()})}}catch(e){}";
