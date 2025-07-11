#!/usr/bin/env python3
import os
import time
import datetime
import subprocess

def main():
    # Assume this script lives in your repo root
    repo_dir = os.path.dirname(os.path.abspath(__file__))

    # Calculate next 23:59 today (or tomorrow if already past)
    now    = datetime.datetime.now()
    target = now.replace(hour=23, minute=59, second=0, microsecond=0)
    if now > target:
        target += datetime.timedelta(days=1)

    wait_secs = (target - now).total_seconds()
    print(f"[{now:%Y-%m-%d %H:%M:%S}] Waiting {wait_secs:.0f}s until {target:%Y-%m-%d %H:%M:%S}…")
    time.sleep(wait_secs)

    # Build a commit message
    timestamp  = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    commit_msg = f"Scheduled commit on {timestamp}"

    # Run git commands
    try:
        subprocess.check_call(["git", "add", "."], cwd=repo_dir)
        subprocess.check_call(["git", "commit", "-m", commit_msg], cwd=repo_dir)
        subprocess.check_call(["git", "push", "origin", "main"], cwd=repo_dir)
        print(f"[{datetime.datetime.now():%Y-%m-%d %H:%M:%S}] Push successful.")
    except subprocess.CalledProcessError as e:
        print(f"Git operation failed: {e}")

if __name__ == "__main__":
    main()
