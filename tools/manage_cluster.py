#!/usr/bin/env python3
import subprocess
import time
import json
import sys

SSH_ENV = {
    "SSH_ASKPASS": "/Users/lazypilot/.ssh/askpass.sh",
    "SSH_ASKPASS_REQUIRE": "force",
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin"
}

DB_URL = "postgresql://chatfat:chatfat@172.17.0.5:5204/chatfat"
MASTER_KEY = "zMHTIZIjeVaJjkF2SyJ9+GCzgMWuGw1p+xIU0w7r5E4="

BACKENDS = [
    ("sys2", "172.17.0.3", 4202, "backend-1"),
    ("sys3", "172.17.0.4", 4203, "backend-2"),
    ("sys4", "172.17.0.5", 3204, "backend-3"),
]

def run_ssh(host, cmd, timeout=15):
    res = subprocess.run(
        ["ssh", "-o", "StrictHostKeyChecking=no", "-o", "PubkeyAuthentication=no", host, cmd],
        env=SSH_ENV, capture_output=True, text=True, timeout=timeout
    )
    return res.returncode, res.stdout, res.stderr

def start_backends():
    print("=== Starting Backends ===")
    for host, ip, port, name in BACKENDS:
        run_ssh(host, "pkill -f 'node.*server.js' 2>/dev/null || true")
        cmd = (
            f"nohup env PORT={port} BACKEND_NAME={name} "
            f"DATABASE_URL='{DB_URL}' MASTER_KEY='{MASTER_KEY}' "
            f"BENCH_ENABLED=1 DB_POOL_MAX=40 TLS_CERT_FILE= TLS_KEY_FILE= "
            f"node /home/student/Chatfat-Messaging/server.js > /tmp/{name}.log 2>&1 &"
        )
        run_ssh(host, cmd)
        print(f"  [+] Started {name} on {host} ({ip}:{port})")
    
    time.sleep(3)
    
    all_ok = True
    for host, ip, port, name in BACKENDS:
        c, out, err = run_ssh(host, f"curl -s http://127.0.0.1:{port}/healthz")
        try:
            d = json.loads(out)
            pers = d.get("persistence")
            ok = d.get("ok")
            print(f"  [✓] {name} ({ip}:{port}): ok={ok}, persistence={pers}")
            if pers != "postgres":
                all_ok = False
        except Exception as e:
            print(f"  [✗] {name} failed: {out} ({e})")
            all_ok = False
    return all_ok

def start_lb(strategy="p2c", health_interval="250ms", health_timeout="600ms", 
             unhealthy_threshold=3, healthy_threshold=1, load_threshold=200):
    print("\n=== Starting Load Balancer on sys1 ===")
    run_ssh("sys1", "pkill -f 'bin/lb' 2>/dev/null || true")
    
    backend_urls = ",".join([f"http://{ip}:{port}" for _, ip, port, _ in BACKENDS])
    lb_cmd = (
        f"nohup /home/student/Chatfat-Messaging/bin/lb "
        f"-listen 0.0.0.0:3201 "
        f"-backends {backend_urls} "
        f"-strategy {strategy} "
        f"-health-interval {health_interval} "
        f"-health-timeout {health_timeout} "
        f"-unhealthy-threshold {unhealthy_threshold} "
        f"-healthy-threshold {healthy_threshold} "
        f"-load-threshold {load_threshold} "
        f"-backend-timeout 45s > /tmp/lb.log 2>&1 &"
    )
    run_ssh("sys1", lb_cmd)
    print(f"  [+] LB launched with backends: {backend_urls}")
    time.sleep(2)
    
    c, out, err = run_ssh("sys1", "curl -s http://127.0.0.1:3201/lb/status")
    print("=== /lb/status ===")
    try:
        d = json.loads(out)
        print(json.dumps(d, indent=2))
        return d
    except Exception as e:
        print(f"LB status error: {out} ({e})")
        return None

if __name__ == "__main__":
    if not start_backends():
        print("Backends failed to start properly!")
        sys.exit(1)
    status = start_lb()
