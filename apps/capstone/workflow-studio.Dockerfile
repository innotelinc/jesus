# Capstone Workflow Studio — browser UI for creating dograh phone agents.
#
# Stdlib-only Python: no pip dependencies, so the image is tiny and builds
# offline. The generator logic is imported from the repo's scripts/ directory
# (generate_dograh_workflow.py), which is copied in at build time.
FROM python:3.12-slim

WORKDIR /app
COPY scripts/generate_dograh_workflow.py scripts/generate_ui.py /app/scripts/

# Run as the unprivileged distro user.
USER nobody

EXPOSE 8090
CMD ["python3", "/app/scripts/generate_ui.py"]
