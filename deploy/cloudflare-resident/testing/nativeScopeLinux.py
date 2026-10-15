import json, os, pathlib, socket, subprocess, time, uuid

HELPER='/opt/switchboard/native-scope.py'
# Local-only cgroup mount in a disposable private cgroup namespace. This
# does not prove provider capability; run the same helper on the target image.
if not os.access('/sys/fs/cgroup', os.W_OK):
    pathlib.Path('/tmp/native-proof-cgroup').mkdir(); subprocess.run(['mount','-t','cgroup2','none','/tmp/native-proof-cgroup'],check=True); subprocess.run(['mount','--bind','/tmp/native-proof-cgroup','/sys/fs/cgroup'],check=True)
pathlib.Path('/workspace/proof').mkdir(parents=True,exist_ok=True)
boot=pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
def ref(label):
    return {'version':1,'id':str(uuid.uuid4()),'boot':boot,'threadKey':label,
            'owner':{'runId':label,'ownerGen':'fixture','ownerFence':1}}
def ctl(mode,r,**extra):
    p=subprocess.run(['/usr/bin/python3','-I',HELPER],input=json.dumps({'mode':mode,'ref':r,**extra}),
                     text=True,capture_output=True,timeout=5)
    assert p.returncode==0,(mode,p.stdout,p.stderr)
    return json.loads(p.stdout)
def launch(r,label,role='trusted'):
    body="import pathlib,time,os; p=pathlib.Path('/workspace/proof/%s'); p.write_text('0');\nif os.fork()==0:\n os.setsid();\n for n in range(1500): p.with_suffix('.child').write_text(str(n)); time.sleep(.02)\n os._exit(0)\nfor n in range(1500): p.write_text(str(n)); time.sleep(.02)" % label
    p=subprocess.Popen(['/usr/bin/python3','-I',HELPER],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    p.stdin.write(json.dumps({'mode':'launch','ref':r,'attempt':str(uuid.uuid4()),'role':role,'user':'worker2','argv':['/usr/bin/python3','-I','-c',body]}));p.stdin.close()
    until=time.monotonic()+3
    target=pathlib.Path('/workspace/proof/'+label)
    while not target.with_suffix('.child').exists() and p.poll() is None and time.monotonic()<until:time.sleep(.02)
    assert target.with_suffix('.child').exists(),(p.stdout.read(),p.stderr.read())
    return p
a,b=ref('a'),ref('b')
ctl('bootstrap',a);ctl('bootstrap',b)
# The fixed provisioning role returns text rather than the control JSON.
def invoke(r, **value):
    return subprocess.run(['/usr/bin/python3','-I',HELPER], input=json.dumps({'mode':'launch','ref':r,'attempt':str(uuid.uuid4()),**value}), text=True,capture_output=True,timeout=5)
account=invoke(a,role='provision',user='worker2')
assert account.returncode==0 and account.stdout=='account-ready\n',account.stderr
subprocess.run(['chmod','777','/workspace/proof'],check=True)
pa,pb=launch(a,'a','user'),launch(b,'b')
inventory=invoke(a,role='inventory',user='worker2')
assert inventory.returncode==0 and inventory.stdout.strip(), 'inventory hid existing UID processes'
# Actual payload profile keeps only explicit source privileges. Generic
# root code cannot modify the controller or the host account/loader database.
check=invoke(b,role='trusted',argv=['/usr/bin/python3','-I','-c',
    "import pathlib,os,errno; caps=dict(x.split(':',1) for x in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in x); assert int(caps['CapBnd'],16)==(1|2|8|64|128); assert os.environ['CI']=='1'; assert os.environ['VITEST_MAX_WORKERS']=='1'; assert os.environ['UV_THREADPOOL_SIZE']=='4';\ntry: pathlib.Path('/etc/native-scope-qualification').write_text('test')\nexcept OSError as e: assert e.errno in (errno.EROFS,errno.EACCES,errno.EPERM)\nelse: raise AssertionError('host etc writable')"])
assert check.returncode==0,check.stderr
# Open-only checks never write kernel controls. The private proc mount must
# independently reject writes even for the retained trusted ownership caps.
controls=invoke(b,role='trusted',argv=['/usr/bin/python3','-I','-c',
    "import os,errno,pathlib; rows=pathlib.Path('/proc/self/mountinfo').read_text().splitlines(); assert any(x.split()[4]=='/proc' and 'ro' in x.split()[5].split(',') for x in rows);\nfor p in ['/proc/sys/kernel/randomize_va_space','/proc/sysrq-trigger']:\n if not os.path.exists(p): continue\n try: fd=os.open(p,os.O_WRONLY)\n except OSError as e: assert e.errno in (errno.EROFS,errno.EACCES,errno.EPERM)\n else: os.close(fd); raise AssertionError('kernel control writable')"])
assert controls.returncode==0,controls.stderr
user_controls=invoke(a,role='user',user='worker2',argv=['/usr/bin/python3','-I','-c',
    "import os,errno,pathlib; assert os.geteuid()==2002; caps=dict(x.split(':',1) for x in pathlib.Path('/proc/self/status').read_text().splitlines() if ':' in x); assert int(caps['CapEff'],16)==0;\nfor p in ['/proc/sys/kernel/randomize_va_space','/proc/sysrq-trigger']:\n if not os.path.exists(p): continue\n try: fd=os.open(p,os.O_WRONLY)\n except OSError as e: assert e.errno in (errno.EROFS,errno.EACCES,errno.EPERM)\n else: os.close(fd); raise AssertionError('user kernel control writable')"])
assert user_controls.returncode==0,user_controls.stderr
victim=pathlib.Path('/workspace/proof/victim');victim.write_text('unchanged')
planted=pathlib.Path('/workspace/proof/planted');planted.symlink_to(victim)
refused=invoke(b,role='write',path=str(planted),content='must not land')
assert refused.returncode==125 and victim.read_text()=='unchanged'
planted.unlink();os.link(victim,planted)
refused=invoke(b,role='write',path=str(planted),content='must not land')
assert refused.returncode==125 and victim.read_text()=='unchanged'
planted.unlink();planted.symlink_to('/workspace/proof',target_is_directory=True)
refused=invoke(b,role='write',path=str(planted/'victim'),content='must not land')
assert refused.returncode==125 and victim.read_text()=='unchanged'
planted.unlink()
# A harmless listener checks the actual helper's reserved-port filter. No
# SDK route, credential or control request is sent.
with socket.socket() as listener:
    listener.bind(('127.0.0.1',3000)); listener.listen()
    probe = "import socket,errno; s=socket.socket();\ntry: s.connect(('127.0.0.1',3000))\nexcept OSError as e: assert e.errno in (errno.EPERM,errno.EACCES)\nelse: raise AssertionError('control connection allowed')"
    for selected, role in ((a,'user'),(b,'trusted')):
        blocked=invoke(selected,role=role,user='worker2',argv=['/usr/bin/python3','-I','-c',probe])
        assert blocked.returncode==0,blocked.stderr
write=invoke(b,role='write',path='/workspace/proof/write.txt',content='private fixture content')
assert write.returncode==0 and pathlib.Path('/workspace/proof/write.txt').read_text()=='private fixture content'

# Benign loader diagnostics must never apply to the privileged setpriv
# launcher. Shell startup code runs only after the UID transition.
loader=invoke(a,role='user',user='worker2',env={'LD_DEBUG':'libs'},argv=['/usr/bin/true'])
assert loader.returncode==0 and 'initialize program: /usr/bin/setpriv' not in loader.stderr,loader.stderr
pathlib.Path('/workspace/proof/startup.sh').write_text('id -u > /home/worker2/native-startup-uid\n')
startup=invoke(a,role='user',user='worker2',env={'BASH_ENV':'/workspace/proof/startup.sh'},argv=['/bin/bash','-c','true'])
assert startup.returncode==0 and pathlib.Path('/home/worker2/native-startup-uid').read_text().strip()=='2002',startup.stderr
# A controller held before cgroup membership cannot be ignored by a close
# observation, even if its group is currently empty.
lock_path='/run/switchboard-native-v1/'+b['id']+'.lock'
holder=subprocess.Popen(['/usr/bin/python3','-I','-c',
    "import fcntl,sys,time; f=open(sys.argv[1]); fcntl.flock(f,fcntl.LOCK_EX); print('held',flush=True); time.sleep(10)",lock_path],stdout=subprocess.PIPE,text=True)
try:
    assert holder.stdout.readline().strip()=='held'
    observed=subprocess.run(['/usr/bin/python3','-I',HELPER],input=json.dumps({'mode':'view','ref':b}),text=True,capture_output=True,timeout=3)
    assert observed.returncode==125,'view ignored an active admission lock'
finally:
    holder.kill(); holder.wait(timeout=3)
before=int(pathlib.Path('/workspace/proof/b').read_text())
assert ctl('close',a)=={'ref':a,'closed':True,'populated':False}
child=pathlib.Path('/workspace/proof/a.child').read_text();time.sleep(.15)
assert pathlib.Path('/workspace/proof/a.child').read_text()==child
assert int(pathlib.Path('/workspace/proof/b').read_text())>before
late=subprocess.run(['/usr/bin/python3','-I',HELPER],input=json.dumps({'mode':'launch','ref':a,'attempt':str(uuid.uuid4()),'role':'trusted','argv':['touch','/workspace/proof/late']}),text=True,capture_output=True)
assert late.returncode==125 and not pathlib.Path('/workspace/proof/late').exists()
c=ref('reserved');ctl('close',c)
late_boot=subprocess.run(['/usr/bin/python3','-I',HELPER],input=json.dumps({'mode':'bootstrap','ref':c}),text=True,capture_output=True)
assert late_boot.returncode==125
ctl('close',b)
pa.wait(timeout=3);pb.wait(timeout=3)
print(json.dumps({'productionHelper':'passed','runA':'empty','detachedA':'stopped','runB':'unaffected','late_launch':'denied','late_bootstrap':'denied','host_inventory':'visible','root_profile':'contained','write':'passed','image_environment':'preserved','control_port':'denied','startup_privileges':'demoted','admission_observation':'locked','kernel_controls':'readonly','user_kernel_controls':'denied','private_write_links':'denied'}))
