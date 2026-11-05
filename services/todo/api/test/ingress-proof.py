"""Run from repository root against the lab ingress. Never prints credentials/cookies."""
import json, ssl, urllib.request, urllib.error, http.cookiejar, shlex, time, threading, subprocess, os
from pathlib import Path
ctx=ssl.create_default_context(cafile='.local/ca.crt')
credentials={}
for line in Path('.local/credentials.env').read_text().splitlines():
    if '=' in line and not line.startswith('#'):
        key,value=line.split('=',1); credentials[key.replace('export ','')]=shlex.split(value)[0]
def session(user):
    jar=http.cookiejar.CookieJar(); op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar),urllib.request.HTTPSHandler(context=ctx))
    req=urllib.request.Request('https://auth.lab.localhost/api/firstfactor',data=json.dumps({'username':user,'password':credentials[user.upper()+'_PASSWORD'],'keepMeLoggedIn':False}).encode(),headers={'Content-Type':'application/json'})
    assert json.load(op.open(req))['status']=='OK'
    return op
alice,bob=session('alice'),session('bob')
def call(op,method,path,data=None,origin=None):
    headers={'X-Requested-With':'fetch','Content-Type':'application/json'}
    if origin:headers['Origin']=origin
    req=urllib.request.Request('https://todo.lab.localhost'+path,method=method,headers=headers,data=json.dumps(data).encode() if data is not None else None)
    try:
        with op.open(req,timeout=15) as response:return response.status,json.load(response)
    except urllib.error.HTTPError as e:return e.code,json.load(e)
name='Proof'+str(int(time.time()))
status,p=call(alice,'POST','/api/projects',{'name':name});assert status==201,(status,p);pid=p['id'];print('create project:',status,pid)
status,t=call(alice,'POST','/api/quick-add',{'text':f'Pay rent today 9am p1 #{name} @bills every month'});assert status==201,(status,t);print('quick add:',status,t['id'])
status,view=call(alice,'GET','/api/tasks?view=today&project='+pid);assert any(x['id']==t['id'] for x in view['tasks']);print('today:',status,'contains task')
status,c=call(alice,'POST',f"/api/tasks/{t['id']}/complete",{'version':t['version']});assert status==200 and c['next'];print('complete recurring:',status,'next due',c['next']['data']['due'])
status,comment=call(alice,'POST',f"/api/tasks/{t['id']}/comments",{'body':'Paid for this month.'});assert status==201;print('comment:',status,comment['author'])
status,_=call(alice,'POST',f'/api/projects/{pid}/members',{'username':'bob','role':'viewer'});assert status==200
status,_=call(bob,'PATCH',f"/api/tasks/{c['next']['id']}",{'version':1,'title':'refused'});assert status==403;print('viewer write:',status)
status,_=call(alice,'POST',f'/api/projects/{pid}/members',{'username':'bob','role':'editor'});assert status==200;print('share editor:',status)
status,_=call(alice,'POST','/api/projects',{'name':'forbidden'},origin='https://pdf.lab.localhost');assert status==403;print('sibling Origin:',status)
# Raw stream stays open on one replica; short-lived requests go through Traefik's other replica.
stream=bob.open(urllib.request.Request('https://todo.lab.localhost/api/events'),timeout=8)
seen=threading.Event(); marker='LiveProof'+str(time.time_ns()); received={}
def read():
    try:
        while True:
            line=stream.readline().decode()
            if marker in line:received['at']=time.monotonic();seen.set();break
    except Exception as exc:received['error']=str(exc);seen.set()
thread=threading.Thread(target=read,daemon=True);thread.start();time.sleep(.15)
started=time.monotonic();status,_=call(alice,'PATCH',f"/api/tasks/{c['next']['id']}",{'version':1,'title':marker});assert status==200
assert seen.wait(3) and 'at' in received,received
print('SSE event latency after mutation request:',round(received['at']-started,3),'seconds');assert received['at']-started<1
stream.close()
env={**os.environ,'KUBECONFIG':str(Path('.local/kubeconfig').resolve())}
logs=subprocess.check_output(['.local/bin/kubectl','-n','todo','logs','-l','app.kubernetes.io/component=api','--tail=200','--prefix'],env=env,text=True)
for line in logs.splitlines():
    if 'stream connected' in line or ('"user":"alice"' in line and ('/complete' in line or ('"method":"PATCH"' in line and c['next']['id'] in line))):print('POD LOG',line)
print('INGRESS PROOF PASSED; retained project',pid)
