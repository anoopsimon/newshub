FROM busybox:1.36.1-musl

WORKDIR /www

COPY index.html styles.css app.js manifest.json sw.js /www/
COPY data /www/data
COPY icons /www/icons

EXPOSE 8080

CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
