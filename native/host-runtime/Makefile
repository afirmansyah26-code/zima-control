CC ?= cc
CFLAGS := -std=c17 -O2 -fPIE -fvisibility=hidden -D_GNU_SOURCE -D_FORTIFY_SOURCE=3 -fstack-protector-strong -Wall -Wextra -Wpedantic -Werror -Wconversion -Wsign-conversion -Wformat=2 -Wshadow -Wstrict-prototypes -Wmissing-prototypes
LDFLAGS := -pie -Wl,-z,relro,-z,now,-z,noexecstack,--as-needed

all: runtime-lifecycle-adapter runtime-authority-readiness runtime-trust-bootstrap

check-runtime-trust-bootstrap:
	$(CC) $(CFLAGS) -fsyntax-only runtime-trust-bootstrap.c

runtime-lifecycle-adapter: runtime-lifecycle-adapter.c
	$(CC) $(CFLAGS) $< -o $@ $(LDFLAGS) -lcrypto

runtime-authority-readiness: runtime-authority-readiness.c
	$(CC) $(CFLAGS) $< -o $@ $(LDFLAGS)

runtime-trust-bootstrap: runtime-trust-bootstrap.c
	$(CC) $(CFLAGS) $< -o $@ $(LDFLAGS) -lsqlite3 -lcrypto

clean:
	rm -f runtime-lifecycle-adapter runtime-authority-readiness runtime-trust-bootstrap

.PHONY: all check-runtime-trust-bootstrap clean
