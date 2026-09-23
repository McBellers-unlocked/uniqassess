"""Operator-only renderer/installer, after recorded cluster isolation checks pass."""
import json
import os
from pathlib import Path
import subprocess
import sys
import boto3

ROOT = Path('/opt/uniqassess-bootstrap/source')
BOOT = ROOT.parent
if not (BOOT / 'isolation-verified').is_file():
    raise SystemExit('Live isolation evidence must be reviewed before enabling the broker.')
os.environ['KUBECONFIG'] = '/etc/rancher/k3s/k3s.yaml'
sys.path.insert(0, str(ROOT / 'lab-runner'))
from runner import Config
from manifests import admission

def kubectl(*args, data=None):
    return subprocess.check_output(['kubectl', *args], input=data, text=True)

def apply(data):
    print(kubectl('apply', '-f', '-', data=json.dumps(data)), end='')

images = json.loads((BOOT / 'images.json').read_text())
uid = json.loads(kubectl('get', 'namespace', 'kube-system', '-o', 'json'))['metadata']['uid']
secret = json.loads(boto3.client('secretsmanager', region_name='eu-west-1').get_secret_value(SecretId='uniqassess/labs/pilot/runner')['SecretString'])
config = Config(secret['key'], 'pilot', uid, 'assessment-sandbox', 'runsc', images['workspace'], ('10.43.0.1/32','10.88.0.10/32'), max_labs=2)
apply({'apiVersion':'v1','kind':'List','items':admission(config)})
print(kubectl('apply','-f',str(ROOT/'lab-runner/operator-rbac.yaml')),end='')
print(kubectl('apply','-f',str(ROOT/'infra/kubernetes-labs/management-placement.yaml')),end='')
namespace='uniqassess-control'
def obj(kind,name,spec=None,api='v1',**other):
    item={'apiVersion':api,'kind':kind,'metadata':{'name':name,'namespace':namespace},**other}
    if spec is not None:item['spec']=spec
    return item

directory=Path('/var/lib/uniqassess-labs/evidence')
directory.mkdir(parents=True,exist_ok=True)
os.chown(directory,10001,10001)
os.chmod(directory,0o700)
pv={'apiVersion':'v1','kind':'PersistentVolume','metadata':{'name':'uniqassess-lab-evidence'},'spec':{
    'capacity':{'storage':'8Gi'},'volumeMode':'Filesystem','accessModes':['ReadWriteOnce'],'persistentVolumeReclaimPolicy':'Retain',
    'storageClassName':'uniqassess-local','local':{'path':str(directory)},
    'nodeAffinity':{'required':{'nodeSelectorTerms':[{'matchExpressions':[{'key':'kubernetes.io/hostname','operator':'In','values':['lab-control']}]}]}}}
apply(pv)
apply(obj('PersistentVolumeClaim','lab-evidence',{'accessModes':['ReadWriteOnce'],'storageClassName':'uniqassess-local','volumeName':'uniqassess-lab-evidence','resources':{'requests':{'storage':'8Gi'}}}))
kubeconfig={'apiVersion':'v1','kind':'Config','clusters':[{'name':'assessment','cluster':{'server':'https://kubernetes.default.svc:443','certificate-authority':'/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'}}],
    'users':[{'name':'broker','user':{'tokenFile':'/var/run/secrets/kubernetes.io/serviceaccount/token'}}],
    'contexts':[{'name':'assessment','context':{'cluster':'assessment','user':'broker'}}],'current-context':'assessment'}
apply(obj('ConfigMap','lab-broker-kubeconfig',data={'kubeconfig':json.dumps(kubeconfig)}))
# Never put this manifest on disk, in command arguments or in deployment output.
apply(obj('Secret','lab-runner',type='Opaque',stringData={'LAB_RUNNER_API_KEY':secret['key']}))
env={
    'LAB_RUNNER_OWNER':'pilot','LAB_CLUSTER_UID':uid,'LAB_RUNTIME_CLASS':'assessment-sandbox','LAB_RUNTIME_HANDLER':'runsc',
    'LAB_WORKSPACE_IMAGE':images['workspace'],'LAB_API_CIDRS':'10.43.0.1/32,10.88.0.10/32','LAB_API_PORTS':'443,6443',
    'KUBECONFIG':'/run/cluster/kubeconfig','LAB_DB_PATH':'/data/labs.sqlite3','LAB_MAX_CONCURRENT':'2',
    'LAB_LISTEN':'0.0.0.0','PORT':'8080','HOME':'/tmp','LAB_DEDICATED_CLUSTER':'true','LAB_NETWORK_POLICY_VERIFIED':'true','LAB_NODE_ISOLATION_VERIFIED':'true'}
placement={'nodeSelector':{'uniqassess.com.node-restriction.kubernetes.io/management':'true'},
    'tolerations':[{'key':'uniqassess.com/management','operator':'Equal','value':'true','effect':'NoSchedule'}]}
security={'runAsNonRoot':True,'runAsUser':10001,'runAsGroup':10001,'fsGroup':10001,'seccompProfile':{'type':'RuntimeDefault'}}
container_security={'allowPrivilegeEscalation':False,'readOnlyRootFilesystem':True,'capabilities':{'drop':['ALL']}}
mounts=[{'name':'kubeconfig','mountPath':'/run/cluster','readOnly':True},{'name':'data','mountPath':'/data'},{'name':'tmp','mountPath':'/tmp'}]
pod={'serviceAccountName':'lab-broker',**placement,'securityContext':security,'terminationGracePeriodSeconds':30,
    'containers':[{'name':'broker','image':images['broker'],'imagePullPolicy':'IfNotPresent','env':[{'name':k,'value':v} for k,v in env.items()],
        'envFrom':[{'secretRef':{'name':'lab-runner'}}],'securityContext':container_security,
        'resources':{'requests':{'cpu':'100m','memory':'128Mi'},'limits':{'cpu':'1','memory':'512Mi'}},'ports':[{'containerPort':8080}],
        'readinessProbe':{'tcpSocket':{'port':8080},'initialDelaySeconds':2,'periodSeconds':5},'volumeMounts':mounts}],
    'volumes':[{'name':'kubeconfig','configMap':{'name':'lab-broker-kubeconfig'}},{'name':'data','persistentVolumeClaim':{'claimName':'lab-evidence'}},{'name':'tmp','emptyDir':{'sizeLimit':'64Mi'}}]}
apply(obj('Deployment','lab-broker',{'replicas':1,'strategy':{'type':'Recreate'},'selector':{'matchLabels':{'app':'lab-broker'}},'template':{'metadata':{'labels':{'app':'lab-broker'}},'spec':pod}},api='apps/v1'))
apply(obj('Service','lab-broker',{'type':'ClusterIP','clusterIP':'10.43.0.20','selector':{'app':'lab-broker'},'ports':[{'port':8080,'targetPort':8080}]}))
janitor=json.loads(kubectl('create','--dry-run=client','-f',str(ROOT/'lab-runner/janitor-cronjob.yaml'),'-o','json'))
for item in janitor['items']:
    if item['kind']=='CronJob':
        spec=item['spec']['jobTemplate']['spec']['template']['spec']
        spec.update(placement)
        spec['containers'][0]['image']=images['broker']
        for variable in spec['containers'][0]['env']:
            if variable['name']=='LAB_RUNNER_OWNER':variable['value']='pilot'
            if variable['name']=='LAB_CLUSTER_UID':variable['value']=uid
    apply(item)
print(kubectl('rollout','status','deployment/lab-broker','-n',namespace,'--timeout=180s'),end='')
print(json.dumps({'clusterUid':uid,'images':images,'capacity':2}))
