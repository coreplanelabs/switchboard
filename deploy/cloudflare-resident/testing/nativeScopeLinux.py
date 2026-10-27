import json, os, pathlib, socket, subprocess, sys, time, uuid

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
    # The counter is written atomically. The assertion below reads this file
    # while the payload is still writing it, and a truncating write would let
    # the reader observe an empty file.
    body="import pathlib,os,time; d=pathlib.Path('/workspace/proof'); p=d/'%s';\ndef put(q,t):\n s=q.with_name(q.name+'.part'+str(os.getpid())); s.write_text(t); os.replace(s,q)\nput(p,'0');\nif os.fork()==0:\n os.setsid();\n for n in range(1500): put(p.with_suffix('.child'),str(n)); time.sleep(.02)\n os._exit(0)\nfor n in range(1500): put(p,str(n)); time.sleep(.02)" % label
    p=subprocess.Popen(['/usr/bin/python3','-I',HELPER],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    p.stdin.write(json.dumps({'mode':'launch','ref':r,'attempt':str(uuid.uuid4()),'role':role,'user':'worker2','argv':['/usr/bin/python3','-I','-c',body]}));p.stdin.close()
    until=time.monotonic()+3
    target=pathlib.Path('/workspace/proof/'+label)
    while not target.with_suffix('.child').exists() and p.poll() is None and time.monotonic()<until:time.sleep(.02)
    assert target.with_suffix('.child').exists(),(p.stdout.read(),p.stderr.read())
    return p
a,b=ref('a'),ref('b')
b['threadKey']=a['threadKey']  # A later run on the same thread still gets a private view.
ctl('bootstrap',a);ctl('bootstrap',b)
# The fixed provisioning role returns text rather than the control JSON.
def invoke(r, **value):
    return subprocess.run(['/usr/bin/python3','-I',HELPER], input=json.dumps({'mode':'launch','ref':r,'attempt':str(uuid.uuid4()),**value}), text=True,capture_output=True,timeout=5)
account=invoke(a,role='provision',user='worker2')
assert account.returncode==0 and account.stdout=='account-ready\n',account.stderr
# Harness state must survive separate exec mount views and model scratch
# cleanup. Pi and OpenCode deliberately keep it under shared sticky /var/tmp.
account_b=invoke(b,role='provision',user='worker3')
assert account_b.returncode==0 and account_b.stdout=='account-ready\n',account_b.stderr
fixtures={item['id']:item for item in json.loads(pathlib.Path(sys.argv[1]).read_text())}
assert fixtures['a']['root']=='/var/tmp/switchboard-pi-a'
assert fixtures['b']['root']=='/var/tmp/switchboard-oc-b'
roots={'worker2':fixtures['a']['root'],'worker3':fixtures['b']['root']}
for selected,user in ((a,'worker2'),(b,'worker3')):
    root=roots[user]
    for command in fixtures[selected['owner']['runId']]['commands']:
        start=invoke(selected,role='user',user=user,argv=['/bin/bash','-c',command])
        assert start.returncode==0,('real harness write failed',start.stderr)
    fifo=invoke(selected,role='user',user=user,argv=['/bin/bash','-c','mkfifo "$1/input"', 'harness-root',root])
    assert fifo.returncode==0,fifo.stderr
    resumed=invoke(selected,role='user',user=user,argv=['/usr/bin/python3','-I','-c',
        "import pathlib,stat,sys; p=pathlib.Path(sys.argv[1]); assert p.joinpath('driver').read_text()=='harness-state'; assert stat.S_ISFIFO(p.joinpath('input').stat().st_mode); assert p.stat().st_mode & 0o777==0o700",root])
    assert resumed.returncode==0,resumed.stderr
# Every exec is a fresh mount namespace. A new generation of the same run
# sees its prior control files; model scratch cleanup cannot remove them.
reattach={**a,'id':str(uuid.uuid4()),'owner':{**a['owner'],'ownerGen':'next-generation','ownerFence':2}}
ctl('bootstrap',reattach)
clean=invoke(reattach,role='user',user='worker2',argv=['/bin/bash','-c','touch /tmp/model-scratch; rm -rf -- /tmp/*; test -p "$1/input" && cat "$1/driver"', 'scratch-cleanup',roots['worker2']])
assert clean.returncode==0 and clean.stdout=='harness-state',clean.stderr
# Another run has a different /var/tmp view, even with the same OS UID.
peer=invoke(b,role='user',user='worker2',argv=['/usr/bin/python3','-I','-c',
    "import pathlib,sys; p=pathlib.Path(sys.argv[1]);\ntry: p.joinpath('driver').read_text()\nexcept (PermissionError,FileNotFoundError): pass\nelse: raise AssertionError('foreign harness readable')",roots['worker2']])
assert peer.returncode==0,peer.stderr
mutate=invoke(b,role='user',user='worker2',argv=['/bin/bash','-c','mkdir -p "$1"; printf foreign > "$1/driver"', 'peer-view',roots['worker2']])
assert mutate.returncode==0,mutate.stderr
original=invoke(a,role='user',user='worker2',argv=['/bin/bash','-c','cat "$1/driver"', 'own-view',roots['worker2']])
assert original.returncode==0 and original.stdout=='harness-state',original.stderr
# A payload cannot modify the host's /var/tmp through its private view.
host=pathlib.Path('/var/tmp/native-host-marker');host.write_text('host-preserved')
private=invoke(a,role='user',user='worker2',argv=['/bin/bash','-c','printf private > /var/tmp/native-host-marker'])
assert private.returncode==0 and host.read_text()=='host-preserved',private.stderr
ctl('close',reattach)
retained=invoke(a,role='user',user='worker2',argv=['/bin/bash','-c','cat "$1/driver"', 'retained-root',roots['worker2']])
assert retained.returncode==0 and retained.stdout=='harness-state',retained.stderr
subprocess.run(['chmod','777','/workspace/proof'],check=True)
pa,pb=launch(a,'a','user'),launch(b,'b')
inventory=invoke(a,role='inventory',user='worker2')
assert inventory.returncode==0 and inventory.stdout.strip(), 'inventory hid existing UID processes'
for selector in ('users', 'pid-users'):
    observed=invoke(b,role='inventory',inventory=selector,argv=['/bin/false'],env={'PATH':'/invalid'})
    assert observed.returncode==0 and 'worker2' in observed.stdout,('host inventory hid neighbor',selector,observed.stderr)
    assert not pathlib.Path('/workspace/proof/inventory-injected').exists()
refused_inventory=invoke(b,role='inventory',inventory='arbitrary',argv=['/bin/touch','/workspace/proof/inventory-injected'])
assert refused_inventory.returncode==125 and not pathlib.Path('/workspace/proof/inventory-injected').exists()

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
# Operator work uses the same physical exclusion without a synthetic run.
legacy_probe=subprocess.run(['/usr/bin/python3','-I',HELPER],input=json.dumps({'mode':'inspect'}),text=True,capture_output=True,check=True)
assert set(json.loads(legacy_probe.stdout))=={'version','boot'}
operator_probe=subprocess.run(['/usr/bin/python3','-I',HELPER],input=json.dumps({'mode':'inspect','operator':True}),text=True,capture_output=True,check=True)
assert json.loads(operator_probe.stdout)=={'version':1,'boot':boot,'operatorScopes':1}
operator={'version':1,'kind':'operation','id':str(uuid.uuid4()),'boot':boot,'owner':{'opOwner':'op:'+str(uuid.uuid4())}}
foreign={'version':1,'kind':'operation','id':str(uuid.uuid4()),'boot':boot,'owner':{'opOwner':'op:'+str(uuid.uuid4())}}
ctl('bootstrap',operator);ctl('bootstrap',foreign)
fixed_git=invoke(operator,role='trusted',argv=['git','config','--system','--get-all','safe.directory'])
assert fixed_git.returncode==0 and fixed_git.stdout.strip()=='/workspace/mirror',fixed_git.stderr
system_write=invoke(operator,role='trusted',argv=['git','config','--system','safe.directory','*'])
assert system_write.returncode!=0,'operator scope made system Git configuration writable'
user_home=invoke(operator,role='user',user='worker1',argv=['/bin/bash','-c','test "$HOME" = /home/worker1 && printf cache > "$HOME/native-operator-cache" && cat "$HOME/native-operator-cache"'])
assert user_home.returncode==0 and user_home.stdout=='cache',user_home.stderr
hybrid={**operator,'threadKey':'fake-run'}
refused=subprocess.run(['/usr/bin/python3','-I',HELPER],input=json.dumps({'mode':'launch','ref':hybrid,'attempt':str(uuid.uuid4()),'role':'trusted','argv':['touch','/workspace/proof/hybrid']}),text=True,capture_output=True)
assert refused.returncode==125 and not pathlib.Path('/workspace/proof/hybrid').exists()
changed={**operator,'owner':{'opOwner':'op:foreign'}}
refused=subprocess.run(['/usr/bin/python3','-I',HELPER],input=json.dumps({'mode':'view','ref':changed}),text=True,capture_output=True)
assert refused.returncode==125,'operator scope borrowed another owner'
po=launch(operator,'operator');pf=launch(foreign,'foreign-operator')
before=int(pathlib.Path('/workspace/proof/foreign-operator').read_text())
# Discarding the original launcher's result does not require its SDK identity.
assert ctl('close',operator)=={'ref':operator,'closed':True,'populated':False}
observed=pathlib.Path('/workspace/proof/operator').read_text();time.sleep(.15)
assert pathlib.Path('/workspace/proof/operator').read_text()==observed
assert int(pathlib.Path('/workspace/proof/foreign-operator').read_text())>before
late=invoke(operator,role='trusted',argv=['touch','/workspace/proof/operator-late'])
assert late.returncode==125 and not pathlib.Path('/workspace/proof/operator-late').exists()
ctl('close',foreign);po.wait(timeout=3);pf.wait(timeout=3)
print(json.dumps({'productionHelper':'passed','runA':'empty','detachedA':'stopped','runB':'unaffected','late_launch':'denied','late_bootstrap':'denied','host_inventory':'visible','root_profile':'contained','write':'passed','image_environment':'preserved','control_port':'denied','startup_privileges':'demoted','admission_observation':'locked','kernel_controls':'readonly','user_kernel_controls':'denied','private_write_links':'denied','harness_roots':'persistent','harness_peer':'protected','operator_scope':'ended','operator_neighbor':'unaffected','operator_late_launch':'denied','operator_owner':'isolated','operator_hybrid':'denied','operator_user_home':'writable','operator_system_config':'readonly','image_safe_directory':'fixed','operator_capability':'qualified','legacy_probe':'unchanged'}))
