#!/usr/bin/env python3
"""tools/step5a.py — Test deduplication at concurrency 100+ through LB at :3201."""
import concurrent.futures
import json
import random
import time
import urllib.request
import urllib.error

LB_URL = "http://127.0.0.1:3201"

def post_message(client_name, msg, msg_id):
    url = f"{LB_URL}/message"
    data = json.dumps({
        "client-name": client_name,
        "msg": msg,
        "id": msg_id
    }).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")
    except Exception as e:
        return 0, str(e)

def main():
    print("=== Step 5a: Deduplication Test ===")
    
    # Generate 450 unique IDs and 50 duplicate IDs scoped to this run
    run_prefix = f"dedup_run_{int(time.time() * 1000)}_"
    unique_ids = [f"{run_prefix}{i}" for i in range(450)]
    dup_ids = random.sample(unique_ids, 50)
    all_ids = unique_ids + dup_ids
    random.shuffle(all_ids)
    
    print(f"Total messages to send: {len(all_ids)} (450 unique + 50 duplicates)")
    print("Sending with concurrency 100+...")
    
    start_time = time.time()
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=120) as executor:
        futures = [
            executor.submit(post_message, f"user_{i%20}", f"Dedup message payload #{i}", mid)
            for i, mid in enumerate(all_ids)
        ]
        for f in concurrent.futures.as_completed(futures):
            results.append(f.result())
            
    elapsed = time.time() - start_time
    statuses = [r[0] for r in results]
    print(f"Sent {len(results)} POSTs in {elapsed:.2f}s")
    print(f"Status codes: 2xx={sum(1 for s in statuses if 200 <= s < 300)}, other={sum(1 for s in statuses if s < 200 or s >= 300)}")
    
    # Wait 1s for any batch commits to settle
    time.sleep(1)
    
    # Fetch /feed
    print("Fetching /feed through LB...")
    feed_req = urllib.request.Request(f"{LB_URL}/feed")
    t0 = time.time()
    with urllib.request.urlopen(feed_req, timeout=15) as resp:
        feed_data = json.loads(resp.read().decode("utf-8"))
    feed_latency = (time.time() - t0) * 1000
    
    returned_messages = feed_data if isinstance(feed_data, list) else feed_data.get("messages", [])
    returned_ids = [m.get("id") for m in returned_messages if isinstance(m, dict) and "id" in m]
    
    # Filter to only this run's test IDs
    test_returned_ids = [mid for mid in returned_ids if mid and str(mid).startswith(run_prefix)]
    unique_returned_ids = set(test_returned_ids)
    
    print(f"Total test messages in feed: {len(test_returned_ids)}")
    print(f"Unique test IDs in feed: {len(unique_returned_ids)}")
    print(f"Duplicates in feed: {len(test_returned_ids) - len(unique_returned_ids)}")
    print(f"/feed response latency: {feed_latency:.2f} ms")
    
    assert len(test_returned_ids) == 450, f"Expected 450 messages, got {len(test_returned_ids)}"
    assert len(unique_returned_ids) == 450, f"Expected 450 unique IDs, got {len(unique_returned_ids)}"
    print(">>> PASS: Exactly 450 unique messages in /feed, 0 duplicates!")

if __name__ == "__main__":
    main()
