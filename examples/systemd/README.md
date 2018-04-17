System D on Ubuntu
==================

**IMPORTANT**: These files are written for Unity Cache Server 5.0.

These files are for setting up per-project cache servers on the same machine
using different ports. This way, the contents of a corrupted server can be
removed without affecting all other builds.

Setting up multiple instances of the same service with different configurations
is called *template units* in systemd parlance.

 * Fedora Magazine on [Template unit
   files](https://fedoramagazine.org/systemd-template-unit-files/)
 * Digital Ocean on [Template
   specifiers](https://www.digitalocean.com/community/tutorials/understanding-systemd-units-and-unit-files#creating-instance-units-from-template-unit-files)
 * System D [full unit
   documentation](https://www.freedesktop.org/software/systemd/man/systemd.unit.html)

Setup
-----

Install Node.js and git. Then check out the cache server itself and install
it's dependencies:

	# From https://nodejs.org/en/download/package-manager/#debian-and-ubuntu-based-linux-distributions
	curl -sL https://deb.nodesource.com/setup_8.x | sudo -E bash -
	sudo apt-get install -y nodejs git
	
	# Add unitycache user + homedir
	adduser --system unitycacheserver
	
	# Get server code
	sudo -u unitycacheserver git clone https://github.com/Unity-Technologies/unity-cache-server ~unitycacheserver/unity-cache-server
	cd ~unitycacheserver/unity-cache-server
	sudo -u unitycacheserver npm --cache ~unitycacheserver/.npm install --production
	cd -
	
Next up is a configuration file for each. Since The cache server does not
actually accept a configuration file, we will write is as command-line
arguments passed to each instance, eg. for *GAME NAME* on port 5002, we add a
file named `5002-GAME-NAME.sh`:

    OPTIONS=--port=5002

The shell-file is read by systemd on service startup and the exported
`$OPTIONS` is appended to the command-line arguments at startup. Only exception
is the `--path` argument which is deduced from the base name of the file
(eg. `5002-GAME-NAME` here) and set uses that as a sub-folder in
unitycacheserver's home directory, eg. `--path
/home/unitycacheserver/5002-GAME-NAME`, as it saves a lot of typing and
copy/paste errors.

Now, move all these files into the `unitycacheserver`-users' directory:
	
	sudo mv unitycacheserver/*.sh ~/unitycacheserver
	sudo chown -R unitycacheserver ~/unitycacheserver/*.sh

Finally, we copy over the systemd-scripts and set up a service instance per
server we want running:

	# Set up server + service-script for each
	cp systemd-services/* /etc/systemd/system/
	
	# Set up a service instance per server we want
	for i in `ls ~unitycacheserver/*.sh`; do systemctl enable unity-cache-server@`basename $i .sh`; done
	
	# Start all servers by starting the 'parent' service
	systemctl start unity-cache-server

