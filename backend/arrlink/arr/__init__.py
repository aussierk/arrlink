"""App adapters for Radarr and Sonarr.

Each adapter wraps one *arr app's REST API and normalizes it to a common
shape so the rest of ArrLink (poller, rules, UI) is app-agnostic.
"""
