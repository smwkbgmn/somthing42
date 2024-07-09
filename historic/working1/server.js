const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const Matter = require('matter-js');

const ballSpeedDefault = 0.042;
const ballSpeedIncreament = 0.006;
const ballTimeScale = 1;

const propertiesBall = {
	label: "ball",

	restitution: 1,
	frictionAir: 0,
	friction: 0,
	density: 1,
	slop: 0.01,
	timeScale: ballTimeScale
};

const propertiesPaddle = {
	label: "paddle",

	isStatic: true,
	restitution: 1,
	friction: 0,
	density: 1,
	slop: 0.01,
};

const propertiesWall = {
	label: "wall",

	isStatic: true,
	restitution: 1,
	friction: 0,
	density: 1,
	slop: 0.01,
}

// (rand -50 ~ +50)% * 0.2 = (-10 ~ +10)% modulation
const paddleRandomBounceScale = 0.3;

const waitingPlayers = [];
const activeGames = new Map();

try {

	function createGame(roomId) {
		// See this issue for the colision configs on Matter
		// https://github.com/liabru/matter-js/issues/394
		Matter.Resolver._restingThresh = 0.001;

		const engine = Matter.Engine.create({ enableSleeping: false });
		engine.world.gravity.y = 0;
		
		const ball = Matter.Bodies.circle(0, 0, 0.1, propertiesBall);
		ball.label = "ball";
		ball.timeScale = ballTimeScale;
		resetBall(ball);
		
		const paddleLeft = Matter.Bodies.rectangle(-4.5, 0, 0.2, 1, propertiesPaddle);
		const paddleRight = Matter.Bodies.rectangle(4.5, 0, 0.2, 1, propertiesPaddle);
		
		const wallTop = Matter.Bodies.rectangle(0, -5, 8, 0.1, propertiesWall);
		const wallBottom = Matter.Bodies.rectangle(0, 5, 8, 0.1, propertiesWall);
		
		Matter.World.add(engine.world, [ball, paddleLeft, paddleRight, wallTop, wallBottom]);
		Matter.Events.on(engine, 'collisionEnd', (event) => handleCollision(event));
		
		// Store the game state
		const game = {
			engine,

			ball,
			paddleLeft,
			paddleRight,
			wallTop,
			wallBottom,

			players: {
				left: null,
				right: null
			},
			gameLoop: null
		};
		
		game.gameLoop = setInterval( () => updateGameState(roomId), 1000 / 60 );
		activeGames.set(roomId, game);
	}

	function resetBall(ball) {
		Matter.Body.setPosition(ball, { x: 0, y: 0 });
		const ballDirection = {
			x: Math.random() > 0.5 ? 1 : -1,
			y: (Math.random() - 0.5) * 2
		};

		const length = Math.sqrt(ballDirection.x ** 2 + ballDirection.y ** 2);
		ballDirection.x /= length;
		ballDirection.y /= length;
		updateBallVelocity(ball, ballDirection, ballSpeedDefault);
	}

	function updateBallVelocity(ball, direction, speed) {

		const velocity = {
			x: direction.x * speed,
			y: direction.y * speed
		};
		Matter.Body.setVelocity(ball, velocity);

	}

	function handleCollision(event) {
		const pair = event.pairs[0];
		if (pair.bodyA.label === "ball" || pair.bodyB.label === "ball") {
			const ball = pair.bodyA.label === "ball"? pair.bodyA : pair.bodyB;
			const speed = Matter.Body.getSpeed(ball);
	
			if (pair.bodyA.label === "paddle" || pair.bodyB.label === "paddle") {
				const direction = {
					x: ball.velocity.x / speed,
					y: ball.velocity.y / speed,
				};

				const mod = 1 + ((Math.random() - 0.5) * paddleRandomBounceScale); 
				direction.y *= mod;
				console.log(mod);

				updateBallVelocity(ball, direction, speed);
			}
			Matter.Body.setSpeed(ball, speed + ballSpeedIncreament);
		}
	}

	function updateGameState(roomId) {
		const game = activeGames.get(roomId);
		if (!game) return;
		
		Matter.Engine.update(game.engine, 1000 / 60);
		
		if (Math.abs(game.ball.position.x) > 7 || Math.abs(game.ball.position.y) > 5) {
			resetBall(game.ball);
		}
		
		const gameState = {
			players: game.players,

			ballPosition: game.ball.position,
			leftPaddlePositionY: game.paddleLeft.position.y,
			rightPaddlePositionY: game.paddleRight.position.y
		};
		
		io.to(roomId).emit('gameState', gameState);
	}

	console.log("Starting server...");

	io.on('connection', (socket) => {
		socket.on('requestMatch', () => {
			if (waitingPlayers.length > 0) {
				const opponent = waitingPlayers.pop();
				const roomId = `game_${Date.now()}`;
				
				createGame(roomId);
				const game = activeGames.get(roomId);

				socket.join(roomId);
				opponent.join(roomId);

				io.to(roomId).emit('matchFound', { roomId });
			} else {
				waitingPlayers.push(socket);
				socket.emit('waitingForOpponent');
			}
		});

		socket.on('joinRoom', ({ roomId, socketId }) => {
			const game = activeGames.get(roomId);
			if (!game) return;
			
			if (game.players.left == null) {
				console.log("joinRoom event is fired by socket", socket.id, "to", roomId, "as left player");
				game.players.left = socketId;
			}
	
			else {
				console.log("joinRoom event is fired by socket", socket.id, "to", roomId, "as right player");
				game.players.right = socketId;
			}

			// console.log(`Player joined room: ${roomId}`);
			socket.join(roomId);
		});
		
		socket.on('playerMove', ({ roomId, movedY }) => {
			const game = activeGames.get(roomId);
			if (!game) return;


			const paddle = socket.id == game.players.left?
				game.paddleLeft : game.paddleRight;
			
			Matter.Body.setPosition(paddle, {
				x: paddle.position.x,
				y: movedY
			});
		});
		
		socket.on('disconnect', () => {
			// Handle disconnection, remove from waiting players if needed
			const index = waitingPlayers.indexOf(socket);
			if (index !== -1) {
				waitingPlayers.splice(index, 1);
			}
			// You might want to handle game cleanup here as well
		});
	});

	function endGame(roomId) {
		const game = activeGames.get(roomId);
		if (game) {
			clearInterval(game.gameLoop);
			activeGames.delete(roomId);
		}
	}

	app.use(express.static('public'));

	app.get('/game', (req, res) => {
	    res.sendFile(path.join(__dirname, 'public', 'game.html'));
	});

	const PORT = process.env.PORT || 3000;
	server.listen(PORT, () => {
	    console.log(`Server running on port ${PORT}`);
	});

} catch (error) {
	console.error("Failed to start server: ", error);
}

