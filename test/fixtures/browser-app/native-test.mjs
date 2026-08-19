if (process.env.ARENA_NATIVE_TEST_FAIL === "1") process.exitCode = 1;
else process.stdout.write("native-browser-suite-ready\n");
