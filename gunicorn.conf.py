# Gunicorn Production Configuration for EXPIREDNOT on Render
import multiprocessing

# Worker Timeout (120 seconds to allow multimodal Gemini AI extraction without watchdog kills)
timeout = 120
graceful_timeout = 30
keepalive = 5

# Workers setup
workers = 2
threads = 2
worker_class = "sync"

# Logging
loglevel = "info"
accesslog = "-"
errorlog = "-"
