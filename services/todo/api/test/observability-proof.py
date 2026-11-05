"""Query real monitoring APIs through temporary kubectl forwards, then close all forwards."""
import subprocess,os,time,json,urllib.request,urllib.parse
from pathlib import Path
env={**os.environ,'KUBECONFIG':str(Path('.local/kubeconfig').resolve())};processes=[]
def get(port,path):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}'+path,timeout=10) as r:return json.load(r)
try:
    for service,port,target in [('prometheus',19090,9090),('loki',13100,3100),('tempo',13200,3200)]:
        processes.append(subprocess.Popen(['.local/bin/kubectl','-n','monitoring','port-forward','service/'+service,f'{port}:{target}'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
    time.sleep(2)
    result=get(19090,'/api/v1/query?'+urllib.parse.urlencode({'query':'up{namespace="todo"}'}));assert result['data']['result'],result
    print('Prometheus up:',json.dumps(result['data']['result']))
    assert all(r['value'][1]=='1' for r in result['data']['result']),result
    logs=get(13100,'/loki/api/v1/query_range?'+urllib.parse.urlencode({'query':'{namespace="todo"} |= "request"','limit':1,'since':'1h'}));print('Loki:',json.dumps(logs['data']['result']));assert logs['data']['result'],logs
    traces=get(13200,'/api/search?'+urllib.parse.urlencode({'tags':'service.name=todo','limit':5}));print('Tempo:',json.dumps(traces));assert traces.get('traces'),traces
    trace_id=traces['traces'][0]['traceID'];full=get(13200,'/api/traces/'+trace_id);print('Tempo full trace:',trace_id,'batches',len(full.get('batches',[])))
    print('OBSERVABILITY PROOF PASSED')
finally:
    for p in processes:p.terminate()
    for p in processes:p.wait(timeout=10)
