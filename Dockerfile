# Ωρολόγιο Πρόγραμμα — 7ο ΓΕΛ Ηρακλείου
#
# A static PWA, so the image is just nginx plus the app files. The schedule is
# baked in at build time; rebuild (or mount over /usr/share/nginx/html/data) to
# publish a new one.
#
#   docker build -t giorgospap777/school-program .
#   docker run -d -p 8080:80 --name programma giorgospap777/school-program
FROM nginx:1.29-alpine

LABEL org.opencontainers.image.title="Ωρολόγιο Πρόγραμμα — 7ο ΓΕΛ Ηρακλείου" \
      org.opencontainers.image.description="Mobile-first PWA that merges a Greek high school student's section, orientation track and electives into one live timetable."

# No RUN instructions anywhere in this file: the build is pure COPY, so it
# cross-builds for arm64 without QEMU emulation.
COPY docker/default.conf /etc/nginx/conf.d/default.conf

WORKDIR /usr/share/nginx/html
COPY index.html app.css app.js sw.js manifest.webmanifest ./
COPY icons/ ./icons/
COPY data/schedule.json ./data/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1/index.html || exit 1
