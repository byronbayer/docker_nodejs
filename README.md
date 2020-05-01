# docker_nodejs

docker build -t <your username>/node-web-app .

docker run -p 49160:8080 -d <your username>/node-web-app

docker ps

docker logs <container id>

Enter the container
docker exec -it <container id> /bin/bash

node jserver.js
