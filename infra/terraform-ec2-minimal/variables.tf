variable "aws_region" {
  type    = string
  default = "us-west-2"
}

variable "project_name" {
  type    = string
  default = "flashscale-dlt"
}

variable "key_name" {
  type        = string
  description = "Existing EC2 key pair name"
}

variable "instance_type" {
  type    = string
  default = "c7i.xlarge"
}

variable "allowed_ssh_cidr" {
  type        = string
  description = "Your public IP in CIDR format"
}

variable "allowed_http_cidr" {
  type        = string
  description = "CIDR allowed to access the demo app"
}

variable "root_volume_size" {
  type    = number
  default = 40
}
